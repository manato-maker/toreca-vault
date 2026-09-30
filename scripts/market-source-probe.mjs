const items=[
 ['メガレックウザex','095/076',''],
 ['ピカチュウex','127/103',''],
 ['リザードン','137/103',''],
 ['コイキング','165/103',''],
 ['ブラッキーex','044/040',''],
 ['エーフィex','043/040',''],
 ['ピカチュウex','044/193',''],
 ['ピカチュウ','025/165','モンスターボールミラー'],
 ['ピカチュウ','001/SV-P',''],
 ['ニンフィアV','231/184',''],
 ['マリル','748/742',''],
 ['ピカチュウ','225/742','ミラー']
];
const norm=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[\s　\-＿_・:：()（）【】\[\]「」『』]/g,'');
const text=html=>String(html||'').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&yen;|&#165;/gi,'¥').replace(/&amp;/gi,'&').replace(/&#x2F;|&#47;/gi,'/').replace(/\s+/g,' ').trim();
async function get(url){
 const r=await fetch(url,{redirect:'follow',headers:{'user-agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36','accept-language':'ja-JP,ja;q=0.9'}});
 return{status:r.status,body:await r.text(),url:r.url};
}
function cardrushMatch(html,name,model,variant){
 const rows=[...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(m=>text(m[1]));
 const pn=norm(name),mn=norm(model),vn=norm(variant);
 const hits=[];
 for(const row of rows){
  const n=norm(row);if(!n.includes(pn)||!n.includes(mn))continue;
  if(vn==='モンスターボールミラー'&&!n.includes(norm('モンスターボールミラー')))continue;
  if(vn==='ミラー'&&!n.includes(norm('ミラー')))continue;
  if(!vn&&/ミラー|エラー|加工エラー/.test(row))continue;
  const ps=[...row.matchAll(/[¥￥]\s*([0-9][0-9,]{1,8})/g)].map(m=>Number(m[1].replace(/,/g,''))).filter(x=>x>0);
  if(ps.length)hits.push({row:row.slice(0,180),price:ps.at(-1)});
 }
 return hits;
}
async function probeCardrush(name,model,variant){
 const tries=[
  ['name+model',name,model],['name',name,''],['model','',model]
 ];
 const all=[];let statuses=[];
 for(const [mode,n,m] of tries){
  const u='https://cardrush.media/pokemon/buying_prices?displayMode='+encodeURIComponent('リスト')+'&limit=100&name='+encodeURIComponent(n)+'&rarity=&model_number='+encodeURIComponent(m)+'&amount=&page=1&sort%5Bkey%5D=amount&sort%5Border%5D=desc';
  try{const r=await get(u);statuses.push(mode+':'+r.status);if(r.status===200){const hits=cardrushMatch(r.body,name,model,variant);all.push(...hits)}}catch(e){statuses.push(mode+':ERR')}
 }
 const prices=[...new Set(all.map(x=>x.price))];
 return{ok:prices.length===1,prices,statuses,hits:all.length};
}
async function probeAltema(name,model,variant){
 const search='https://altema.jp/pokemoncard/?s='+encodeURIComponent(name+' '+model);
 try{
  const sr=await get(search);if(sr.status!==200)return{ok:false,status:'search:'+sr.status,prices:[],pages:0};
  const links=[...sr.body.matchAll(/href=["'](https:\/\/altema\.jp\/pokemoncard\/[^"'#?]+)["']/gi)].map(m=>m[1]).filter((x,i,a)=>a.indexOf(x)===i).slice(0,12);
  const prices=[];let pages=0;
  for(const u of links){
    let r;try{r=await get(u)}catch{continue}if(r.status!==200)continue;pages++;
    const tx=text(r.body),n=norm(tx);if(!n.includes(norm(name))||!n.includes(norm(model)))continue;
    if(variant&& !n.includes(norm(variant)))continue;
    const pos=Math.max(0,n.indexOf(norm(model)));
    const around=tx.slice(Math.max(0,pos-1200),pos+2600);
    for(const re of [/(?:買取価格|買取相場|買取)\s*[:：]?\s*[¥￥]?\s*([0-9][0-9,]{1,8})\s*円/g,/買取\s*[¥￥]\s*([0-9][0-9,]{1,8})/g]){
      let m;while((m=re.exec(around))){const p=Number(m[1].replace(/,/g,''));if(p>0)prices.push(p)}
    }
  }
  const unique=[...new Set(prices)];
  return{ok:unique.length>=1,prices:unique.slice(0,10),status:'search:'+sr.status,pages};
 }catch(e){return{ok:false,status:'ERR '+String(e.message||e),prices:[],pages:0}}
}
const results=[];
for(const [name,model,variant] of items){
 const [cardrush,altema]=await Promise.all([probeCardrush(name,model,variant),probeAltema(name,model,variant)]);
 const row={name,model,variant,cardrush,altema};results.push(row);console.log('PROBE '+JSON.stringify(row));
}
const summary={
 total:results.length,
 cardrushExact:results.filter(x=>x.cardrush.ok).length,
 altemaExtractable:results.filter(x=>x.altema.ok).length,
 both:results.filter(x=>x.cardrush.ok&&x.altema.ok).length
};
console.log('SUMMARY '+JSON.stringify(summary));
