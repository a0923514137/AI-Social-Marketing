// Pure fail-closed gate; no external calls.
export type Platform = "facebook" | "instagram" | "threads" | "youtube";
export function canReply(input: {
  platform: Platform; mode: string; globalEnabled: boolean;
  platformEnabled: boolean; environmentEnabled: boolean;
  activation: string | null; publishedAt: string; now: number;
}): boolean {
  const modes: Record<Platform,string> = {facebook:"webhook",instagram:"run",threads:"scan",youtube:"run"};
  const activation = Date.parse(input.activation ?? "");
  const published = Date.parse(input.publishedAt);
  return input.globalEnabled === true && input.platformEnabled === true &&
    input.environmentEnabled === true && input.mode === modes[input.platform] &&
    Number.isFinite(activation) && Number.isFinite(published) &&
    Number.isFinite(input.now) && published > activation && published <= input.now;
}
