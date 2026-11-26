"""R130-09 integration tests. Requires psycopg and an empty, migrated loopback database."""

import sys
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier

import psycopg
from psycopg.conninfo import conninfo_to_dict


if len(sys.argv) != 2:
    raise SystemExit("Usage: python scripts/test-youtube-delivery.py <local PostgreSQL DSN>")
DSN = sys.argv[1]
connection = conninfo_to_dict(DSN)
if connection.get("host") not in {"127.0.0.1", "::1"} or connection.get("dbname") != "r130_youtube_test":
    raise SystemExit("Use a disposable loopback PostgreSQL database named r130_youtube_test")


def query(sql, params=(), role="service_role"):
    with psycopg.connect(DSN) as conn:
        with conn.cursor() as cursor:
            cursor.execute("set role " + role)
            cursor.execute(sql, params)
            return cursor.fetchone()[0] if cursor.description else None


def reserve(comment=None, channel="channel"):
    return query(
        "select public.r130_youtube_reserve(%s, %s, 'viewer', now() - interval '1 hour', 'AI reply')",
        (channel, comment),
    )


def parallel(count, action):
    workers = min(12, count)
    barrier = Barrier(workers)

    def run(index):
        if index < workers:
            barrier.wait(timeout=15)
        return action(index)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(run, range(count)))


class YoutubeDelivery(unittest.TestCase):
    def setUp(self):
        query(
            "truncate public.r130_youtube_claims, public.r130_youtube_settings, public.r130_youtube_quota",
            role="postgres",
        )

    def enable(self, channel="channel"):
        query("select public.r130_youtube_setup(%s, now() - interval '1 day')", (channel,))
        query("update public.r130_youtube_settings set send_enabled = true where channel_id = %s", (channel,))

    def test_fixed_baseline_and_default_off(self):
        baselines = parallel(12, lambda _: query("select public.r130_youtube_setup('channel')"))
        self.assertTrue(all(value == baselines[0] for value in baselines))
        self.assertFalse(baselines[0]["send_enabled"])
        self.assertEqual(reserve("comment")["status"], "disabled")
        value = query("select public.r130_youtube_setup('channel', now() - interval '1 day')")
        self.assertEqual(value, baselines[0])
        query("update public.r130_youtube_settings set send_enabled = true")
        self.assertEqual(reserve("historical")["status"], "ineligible")
        self.assertEqual(
            query("select public.r130_youtube_reserve('channel','own','channel',now(),'reply')")["status"],
            "ineligible",
        )

    def test_single_claim_under_contention(self):
        self.enable()
        statuses = parallel(24, lambda _: reserve("same")["status"])
        self.assertEqual(statuses.count("reserved"), 1)
        self.assertEqual(statuses.count("duplicate"), 23)
        self.assertEqual(query("select array[units, send_attempts] from public.r130_youtube_quota"), [50, 1])

    def test_global_daily_send_cap_under_contention(self):
        self.enable()
        self.enable("second")
        statuses = parallel(165, lambda i: reserve(str(i), "second" if i % 2 else "channel")["status"])
        self.assertEqual(statuses.count("reserved"), 150)
        self.assertEqual(statuses.count("daily_limit"), 15)
        self.assertEqual(query("select array[units, send_attempts] from public.r130_youtube_quota"), [7500, 150])
        self.assertEqual(query("select count(*) from public.r130_youtube_claims"), 150)

    def test_shared_quota_and_pacific_day(self):
        self.enable()
        day = query("select (clock_timestamp() at time zone 'America/Los_Angeles')::date")
        query("insert into public.r130_youtube_quota values (%s, 10000, 150, true)", (day - timedelta(days=1),))
        current = reserve()
        self.assertEqual(current["quota_day"], day.isoformat())
        query("update public.r130_youtube_quota set units = 9949 where quota_day = %s", (day,))
        self.assertEqual(reserve("last-send")["status"], "reserved")
        statuses = parallel(12, lambda _: reserve()["status"])
        self.assertEqual(statuses.count("reserved"), 1)
        self.assertEqual(statuses.count("quota"), 11)
        query("update public.r130_youtube_quota set units = 1, blocked = true where quota_day = %s", (day,))
        self.assertEqual(reserve("blocked")["status"], "quota")
        self.assertEqual(query("select count(*) from public.r130_youtube_claims"), 1)

    def test_stale_claim_recovery_is_leased_and_terminal(self):
        self.enable()
        self.assertEqual(reserve("comment")["status"], "reserved")
        self.assertEqual(query("select public.r130_youtube_pending('channel')"), [])
        query("update public.r130_youtube_claims set attempted_at = now() - interval '3 minutes'")
        results = parallel(12, lambda _: query("select public.r130_youtube_pending('channel')"))
        self.assertEqual(sum(map(len, results)), 1)
        self.assertEqual(reserve("comment")["status"], "duplicate")
        self.assertTrue(query("select public.r130_youtube_finish('channel','comment','uncertain')"))
        self.assertTrue(query("select public.r130_youtube_finish('channel','comment','sent','remote-id')"))
        self.assertFalse(query("select public.r130_youtube_finish('channel','comment','uncertain')"))
        self.assertEqual(query("select response_id from public.r130_youtube_claims"), "remote-id")

    def test_anonymous_and_authenticated_have_no_access(self):
        for role in ("anon", "authenticated"):
            for sql in (
                "select public.r130_youtube_setup('channel')",
                "select public.r130_youtube_reserve('channel')",
                "select public.r130_youtube_pending('channel')",
                "select public.r130_youtube_known('channel',array['comment'])",
                "select public.r130_youtube_finish('channel','comment','uncertain')",
                "select * from public.r130_youtube_claims",
            ):
                with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                    query(sql, role=role)


if __name__ == "__main__":
    for table in ("claims", "settings", "quota"):
        if query("select count(*) from public.r130_youtube_" + table, role="postgres"):
            raise SystemExit("Use an empty, migrated, disposable database")
    unittest.main(argv=[sys.argv[0]], verbosity=2)
