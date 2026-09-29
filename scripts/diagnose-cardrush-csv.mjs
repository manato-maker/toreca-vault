const item={name:'リザードン',model:'137/103'};
for(const keyword of [item.name,item.model]){
 const u='https://www.toretoku.jp/kaitori/pokemon/item-search?genre=pokemon&keyword='+encodeURIComponent(keyword);
 const res=await fetch(u,{headers:{'user-agent':'Mozilla/5.0'}});
 const html=await res.text();
 const idx=html.indexOf(item.model);
 console.log(JSON.stringify({keyword,status:res.status,length:html.length,idx,snippet:idx>=0?html.slice(Math.max(0,idx-900),Math.min(html.length,idx+2200)):''}));
}