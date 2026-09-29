const items=[
 {name:'リザードン',set:'M6a 137/103',model:'137/103'},
 {name:'コイキング',set:'M6a 165/103',model:'165/103'},
 {name:'ブラッキーex',set:'MF 044/040',model:'044/040'},
 {name:'エーフィex',set:'MF 043/040',model:'043/040'}
];
const norm=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[\s　\-＿_・:：()（）【】\[\]「」『』]/g,'');
const plain=html=>String(html||'').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&yen;|&#165;/gi,'¥').replace(/&amp;/gi,'&').replace(/\s+/g,' ').trim();

for(const item of items){
  const out={item,cardrush:[],toretoku:[]};
  for(const modelFilter of [item.model,'']){
    const u=new URL('https://cardrush.media/pokemon/buying_prices');
    for(const [k,v] of Object.entries({displayMode:'リスト',limit:'100',name:item.name,rarity:'',model_number:modelFilter,amount:'',page:'1'}))u.searchParams.set(k,v);
    u.searchParams.set('sort[key]','amount');u.searchParams.set('sort[order]','desc');
    try{
      const res=await fetch(u,{headers:{'user-agent':'Mozilla/5.0'}});
      const html=await res.text();
      const rows=[...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(m=>plain(m[1]));
      for(const text of rows){
        const n=norm(text);
        if(n.includes(norm(item.name))&&n.includes(norm(item.model))){
          const prices=[...text.matchAll(/[¥￥]\s*([0-9][0-9,]{1,8})/g)].map(m=>Number(m[1].replace(/,/g,'')));
          out.cardrush.push({filter:modelFilter,status:res.status,text:text.slice(0,350),prices});
        }
      }
      if(!out.cardrush.length&&modelFilter===item.model)out.cardrush.push({filter:modelFilter,status:res.status,noMatch:true,htmlLength:html.length});
    }catch(e){out.cardrush.push({filter:modelFilter,error:String(e)})}
  }
  for(const keyword of [item.name,item.model]){
    try{
      const u='https://www.toretoku.jp/kaitori/pokemon/item-search?genre=pokemon&keyword='+encodeURIComponent(keyword);
      const res=await fetch(u,{headers:{'user-agent':'Mozilla/5.0'}});
      const html=await res.text();
      const hits=[];
      const re=/\\\"name\\\":\\\"([^\\\"]+)\\\",\\\"itemCode\\\":\\\"([^\\\"]+)\\\",\\\"price\\\":(\d+),\\\"sellPrice\\\":\d+,\\\"modelNumber\\\":\\\"([^\\\"]+)\\\",\\\"imageUrl\\\":\\\"[^\\\"]+\\\",\\\"rarity\\\":\\\"([^\\\"]*)\\\"/g;
      let m;while((m=re.exec(html))){if(norm(m[4]).endsWith(norm(item.model)))hits.push({name:m[1],itemCode:m[2],price:Number(m[3]),modelNumber:m[4],rarity:m[5]})}
      out.toretoku.push({keyword,status:res.status,hits:hits.slice(0,20),htmlLength:html.length});
    }catch(e){out.toretoku.push({keyword,error:String(e)})}
  }
  console.log(JSON.stringify(out));
}
