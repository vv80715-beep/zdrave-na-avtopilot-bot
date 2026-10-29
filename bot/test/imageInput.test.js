const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createImageHandler, downloadImage, IMAGE_RULES, MAX_BYTES } = require('../imageInput');
const { createOpenAIClientWrapper } = require('../textAIClient');
const jpeg = Buffer.from([255,216,255,224,0,0,0,0,0,0,255,217]);
const image = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
function setup({ access = true, message = {}, fail = false, state = 'trial' } = {}) {
  const replies = [], requests = [], downloads = [];
  const ctx = { from: { id: 99 }, message, reply: async text => replies.push(text) };
  const handler = createImageHandler({
    gateChat: async () => { if (!access) { await ctx.reply('Изтекъл Trial'); return null; } return { state }; },
    getProvider: () => 'openai',
    download: async (_ctx, file) => { downloads.push(file); if (fail) throw Error('secret URL'); return image; },
    askEli: async (_ctx, question, opts) => requests.push({ question, opts }),
  });
  return { handler, ctx, replies, requests, downloads };
}
for (const caption of ['Каква храна се вижда?', undefined]) test(`photo caption=${caption}`, async () => {
  const h = setup({ message: { photo: [{file_id:'small',width:1,height:1},{file_id:'large',width:20,height:20}], caption } });
  await h.handler(h.ctx);
  assert.equal(h.downloads[0].file_id,'large');
  assert.equal(h.requests.length,1);
  assert.match(h.requests[0].question, caption ? /Каква храна/ : /Какво се вижда/);
});
test('expired access precedes all download and AI work',async()=>{
  const h=setup({access:false,message:{photo:[{file_id:'a'}]}});
  await h.handler(h.ctx); assert.equal(h.requests.length,0); assert.equal(h.downloads.length,0);
});
for (const state of ['trial','owner','seven_day','monthly','yearly']) test(`access preserved ${state}`,async()=>{
  const h=setup({state,message:{document:{file_id:'a',mime_type:'image/png'}}});
  await h.handler(h.ctx); assert.equal(h.requests.length,1); assert.equal(h.requests[0].opts.status.state,state);
});
test('unsupported and oversized documents fail before download',async()=>{
  for(const document of [{mime_type:'application/pdf'}, {mime_type:'image/jpeg',file_size:MAX_BYTES+1}]){
    const h=setup({message:{document}}); await h.handler(h.ctx);
    assert.equal(h.requests.length,0); assert.equal(h.downloads.length,0); assert.equal(h.replies.length,1);
  }
});
test('failed download gives one safe fallback',async()=>{
  const h=setup({fail:true,message:{photo:[{file_id:'a'}]}}); await h.handler(h.ctx);
  assert.equal(h.requests.length,0); assert.equal(h.replies.length,1); assert.doesNotMatch(h.replies[0],/secret/);
});
test('download validates magic bytes, actual size and Telegram origin',async()=>{
  const ctx={telegram:{getFileLink:async()=> 'https://api.telegram.org/file/botfake/photo.jpg'}};
  const response=bytes=>async()=>new Response(bytes);
  assert.equal(await downloadImage(ctx,{file_id:'a',mime_type:'image/jpeg'},response(jpeg)),image);
  await assert.rejects(downloadImage(ctx,{file_id:'a',mime_type:'image/png'},response(jpeg)));
  await assert.rejects(downloadImage(ctx,{file_id:'a'},response(Buffer.alloc(MAX_BYTES+1))));
  await assert.rejects(downloadImage(ctx,{file_id:'a'},response(Buffer.from('not an image'))));
  await assert.rejects(downloadImage({telegram:{getFileLink:async()=> 'https://evil.example/x'}},{file_id:'a'},response(jpeg)));
});
test('OpenAI wrapper sends one multimodal request with retries disabled',async()=>{
  let calls=0;
  const client=createOpenAIClientWrapper({chat:{completions:{create:async(req,opts)=>{
    calls++; assert.equal(req.model,'gpt-4o-mini'); assert.equal(opts.maxRetries,0);
    assert.equal(req.messages.at(-1).content[1].image_url.url,image);
    assert.equal(req.noRetries,undefined); throw Error('mock failure');
  }}}}, 'image-offline');
  await assert.rejects(client.chat.completions.create({model:'gpt-4o-mini',noRetries:true,messages:[
    {role:'user',content:[{type:'text',text:'Снимка'},{type:'image_url',image_url:{url:image}}]},
  ]}));
  assert.equal(calls,1);
});
test('medical and identity safety instructions are present',()=>{
  assert.match(IMAGE_RULES,/Не идентифицирай реални хора/);
  assert.match(IMAGE_RULES,/чувствителни черти/);
  assert.match(IMAGE_RULES,/не поставяй диагноза/);
  assert.match(IMAGE_RULES,/112/); assert.match(IMAGE_RULES,/не могат да бъдат точни/);
});
