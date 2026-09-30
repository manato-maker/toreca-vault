const items=[
 ['メガレックウザex','M6 095/076','095/076',''],
 ['ピカチュウex','M6a 127/103','127/103',''],
 ['リザードン','M6a 137/103','137/103',''],
 ['コイキング','M6a 165/103','165/103',''],
 ['ブラッキーex','MF 044/040','044/040',''],
 ['エーフィex','MF 043/040','043/040',''],
 ['ピカチュウex','M2a 044/193','044/193',''],
 ['ピカチュウ','SV2a 025/165','025/165','モンスターボールミラー'],
 ['ピカチュウ','PROMO 001/SV-P','001/SV-P',''],
 ['ニンフィアV','S8b 231/184','231/184',''],
 ['マリル','MC 748/742','748/742',''],
 ['ピカチュウ','MC 225/742','225/742','ミラー']
];
const norm=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[\s　\-＿_・:：()（）【】\[\]「」『』]/g,'');
function nameMatches(wanted,actual,model){
 const w=norm(wanted),a=norm(actual);if(a===w)return true;
 const raw=String(actual||'').replace(/[（(](?:マスターボールミラー|モンスターボールミラー|ミラー)[）)]/g,'');
 const stripped=norm(raw);if(stripped===w)return true;
 const noLevel=norm(raw.replace(/\s*LV\.?\s*\d+(?:\.\d+)?\s*$/i,''));if(noLevel===w)return true;
 if(String(model||'').toUpperCase()==='223/193'&&w===norm('メガリザードンex')&&stripped===norm('メガリザードンXex'))return true;
 return false;
}
function variantMatches(actualName,rarity,variant){
 const text=norm(String(actualName||'')+' '+String(rarity||'')),v=norm(variant||'');
 if(v===norm('マスターボールミラー'))return text.includes(norm('マスターボールミラー'))||text.includes(norm('マスターボール'));
 if(v===norm('モンスターボールミラー'))return (text.includes(norm('モンスターボールミラー'))||text.includes(norm('モンスターボール')))&&!text.includes(norm('マスターボール'));
 if(v===norm('ミラー'))return text.includes(norm('ミラー'))&&!text.includes(norm('モンスターボール'))&&!text.includes(norm('マスターボール'));
 return !/ミラー|エラー|加工エラー/.test(text);
}
async function one(product,setText,model,variant){
 const full=norm(setText),mn=norm(model),matches=[],statuses=[];
 for(const keyword of [product,model].filter((x,i,a)=>x&&a.indexOf(x)===i)){
   const url='https://www.toretoku.jp/kaitori/pokemon/item-search?genre=pokemon&keyword='+encodeURIComponent(keyword);
   let r;try{r=await fetch(url,{redirect:'follow',headers:{'user-agent':'Mozilla/5.0'}})}catch(e){statuses.push('ERR');continue}
   statuses.push(String(r.status));if(r.status!==200)continue;
   const html=await r.text();
   const re=/\{\\"name\\":\\"([^\\"]+)\\",\\"itemCode\\":\\"([^\\"]+)\\",\\"price\\":(\d+),\\"sellPrice\\":\d+,\\"modelNumber\\":\\"([^\\"]+)\\",\\"imageUrl\\":\\"[^\\"]+\\",\\"rarity\\":(?:\\"([^\\"]*)\\"|null)\}/g;
   let m;while((m=re.exec(html))){
     const name=m[1],price=Number(m[3]),modelNumber=m[4],rarity=m[5]||'',itemModel=norm(modelNumber);
     if(!Number.isFinite(price)||price<=0)continue;
     if(full?itemModel!==full:!itemModel.endsWith(mn))continue;
     if(!nameMatches(product,name,model))continue;
     if(!variantMatches(name,rarity,variant))continue;
     matches.push({name,price,modelNumber,rarity});
   }
   const prices=[...new Set(matches.map(x=>x.price))];if(prices.length)break;
 }
 return{product,setText,model,variant,statuses,matches,prices:[...new Set(matches.map(x=>x.price))]};
}
for(const item of items){const r=await one(...item);console.log('RESULT '+JSON.stringify(r))}
