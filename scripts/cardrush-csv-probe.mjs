const url='https://docs.google.com/spreadsheets/d/e/2PACX-1vQT3Q9qDbZUpnP3_WH2I5qw8O-U_PqXVhhoIzH2o-tSzeDND9FTuoGKbZiNHTbrzTgKAUA2_SvXFh_2/pub?gid=1490875147&single=true&output=csv';
const res=await fetch(url,{redirect:'follow',headers:{'user-agent':'Mozilla/5.0'}});
console.log('HTTP',res.status,res.url);
const body=await res.text();
console.log('BYTES',body.length);
const terms=[
 ['メガレックウザex','095/076'],
 ['ピカチュウex','127/103'],
 ['リザードン','137/103'],
 ['コイキング','165/103'],
 ['ブラッキーex','044/040'],
 ['エーフィex','043/040'],
 ['ピカチュウex','044/193'],
 ['ピカチュウ','025/165'],
 ['ピカチュウ','001/SV-P'],
 ['ニンフィアV','231/184'],
 ['マリル','748/742'],
 ['ピカチュウ','225/742']
];
const lines=body.split(/\r?\n/);
for(const [name,model] of terms){
 const hits=lines.filter(l=>l.includes(model));
 console.log('MODEL',model,'name',name,'hits',hits.length);
 for(const h of hits.slice(0,8))console.log('ROW',h.slice(0,500));
}
