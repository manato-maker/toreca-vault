export const SCHEMA_VERSION=1;
export const COLLECTIONS=['lotteries','purchases','boxes','packs','cards','openings','sales','products'];
export const emptyState=()=>({schemaVersion:SCHEMA_VERSION,updatedAt:new Date().toISOString(),lotteries:[],purchases:[],boxes:[],packs:[],cards:[],openings:[],sales:[],products:[]});
export const id=()=>globalThis.crypto?.randomUUID?.()||`id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
export const normalize=(input={})=>{const out=emptyState();for(const key of COLLECTIONS)out[key]=Array.isArray(input[key])?input[key]:[];out.updatedAt=input.updatedAt||out.updatedAt;return out};

const legacyMap={lottery:'lotteries',raffles:'lotteries',purchase:'purchases',sealedBoxes:'boxes',boxInventory:'boxes',loosePacks:'packs',packInventory:'packs',cardInventory:'cards',opened:'openings',salesHistory:'sales',productMaster:'products'};
export function importLegacy(raw){
  const source=raw?.data&&typeof raw.data==='object'?raw.data:raw;
  const converted=emptyState();let count=0;
  for(const [key,value] of Object.entries(source||{})){
    const target=COLLECTIONS.includes(key)?key:legacyMap[key];if(!target||!Array.isArray(value))continue;
    converted[target]=value.map(item=>({...item,id:item.id||id(),importedAt:new Date().toISOString()}));count+=value.length;
  }
  if(!count)throw new Error('対応する旧データが見つかりませんでした');
  return {state:converted,count};
}
