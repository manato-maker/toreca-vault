const items=[
 {name:'リザードン',model:'137/103'},
 {name:'コイキング',model:'165/103'},
 {name:'ブラッキーex',model:'044/040'},
 {name:'エーフィex',model:'043/040'}
];
for(const item of items){
 const u='https://www.toretoku.jp/kaitori/pokemon/item-search?genre=pokemon&keyword='+encodeURIComponent(item.name);
 const res=await fetch(u,{headers:{'user-agent':'Mozilla/5.0'}});
 const html=await res.text();
 const terms=[item.model,item.name,'modelNumber','itemCode','price'];
 const out={item,status:res.status,length:html.length,terms:{}};
 for(const term of terms){
   const idx=html.indexOf(term);
   out.terms[term]={idx,snippet:idx>=0?html.slice(Math.max(0,idx-450),Math.min(html.length,idx+1200)):''};
 }
 console.log(JSON.stringify(out));
}