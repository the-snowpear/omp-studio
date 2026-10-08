/** Same bounded base64 image channel as Composer; no file is created before submission. */
export interface AskImage {type:"image";mimeType:"image/png"|"image/jpeg"|"image/gif"|"image/webp";data:string}
export interface AskAnswerPayload {results:Array<{id:string;selectedOptions:string[];customInput?:string;note?:string;customInputImages?:AskImage[];noteImages?:AskImage[]}>}
export function validateAskAnswerPayload(value:unknown):asserts value is AskAnswerPayload{
 const object=(v:unknown,keys:readonly string[]):Record<string,unknown>=>{if(!v||typeof v!=="object"||Array.isArray(v)||Object.keys(v).some(key=>!keys.includes(key)))throw Error("Invalid Ask answer fields");return v as Record<string,unknown>;};
 const root=object(value,["results"]);if(!Array.isArray(root.results)||root.results.length>32)throw Error("Invalid Ask answers");let bytes=0,images=0;const ids=new Set<string>();
 for(const value of root.results){const row=object(value,["id","selectedOptions","customInput","note","customInputImages","noteImages"]);if(typeof row.id!=="string"||!row.id||row.id.length>512||ids.has(row.id))throw Error("Invalid Ask question identity");ids.add(row.id);
  if(!Array.isArray(row.selectedOptions)||row.selectedOptions.length>100||row.selectedOptions.some(v=>typeof v!=="string"||v.length>4096))throw Error("Invalid Ask selection");
  for(const key of ["customInput","note"])if(row[key]!==undefined&&(typeof row[key]!=="string"||(row[key] as string).length>65536))throw Error("Invalid Ask text");
  for(const key of ["customInputImages","noteImages"]){const list=row[key];if(list===undefined)continue;if(!Array.isArray(list)||list.length>4)throw Error("Too many Ask images");for(const value of list){const image=object(value,["type","mimeType","data"]);if(image.type!=="image"||!["image/png","image/jpeg","image/gif","image/webp"].includes(image.mimeType as string)||typeof image.data!=="string"||!image.data||image.data.length>262144||image.data.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(image.data))throw Error("Invalid Ask image");bytes+=image.data.length;images++;}}
 }
 if(images>8||bytes>512*1024||new TextEncoder().encode(JSON.stringify(value)).length>900*1024)throw Error("Ask attachments exceed the response budget");
}
