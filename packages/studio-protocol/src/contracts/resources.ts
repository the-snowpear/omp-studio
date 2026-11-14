export interface ResourceOperation {kind:"resource.read";sessionId:string;uri:string;offset?:number;version?:string}
export interface ResourcePage {uri:string;version:string;offset:number;total:number;nextOffset?:number;text:string;truncated:boolean;image?:{mimeType:string;data:string}}
