const url='https://docs.google.com/spreadsheets/d/e/2PACX-1vQT3Q9qDbZUpnP3_WH2I5qw8O-U_PqXVhhoIzH2o-tSzeDND9FTuoGKbZiNHTbrzTgKAUA2_SvXFh_2/pub?gid=1490875147&single=true&output=csv';
const wanted=['137/103','165/103','044/040','043/040','095/076','127/103'];
const res=await fetch(url,{redirect:'follow'});
const text=await res.text();
console.log(JSON.stringify({status:res.status,length:text.length}));
for(const model of wanted){
 const lines=text.split(/\r?\n/).filter(x=>x.includes(model));
 console.log(JSON.stringify({model,count:lines.length,lines:lines.slice(0,10).map(x=>x.slice(0,500))}));
}
