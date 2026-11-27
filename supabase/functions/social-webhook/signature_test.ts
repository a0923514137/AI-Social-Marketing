import { handleWebhook } from "./index.ts";
Deno.test("missing and malformed signatures rejected", async()=>{
 for(const signature of ["","sha256=bad"]){
  const response=await handleWebhook(new Request("https://example.invalid",{method:"POST",headers:{"x-hub-signature-256":signature},body:"{}"}));
  if(response.status!==403 || await response.text()!=="invalid_signature")throw Error("signature gate");
 }
});
Deno.test("incorrect HMAC rejected for both platforms",async()=>{
 for(const [object,key] of [["page","FB_APP_SECRET"],["instagram","FB_APP_SECRET"]]){
  const old=Deno.env.get(key);
  try{
   Deno.env.set(key,"offline-test-secret");
   const response=await handleWebhook(new Request("https://example.invalid",{method:"POST",headers:{"x-hub-signature-256":"sha256="+"00".repeat(32)},body:JSON.stringify({object})}));
   if(response.status!==403 || await response.text()!=="invalid_signature")throw Error("HMAC gate");
  }finally{if(old===undefined)Deno.env.delete(key);else Deno.env.set(key,old);}
 }
});
