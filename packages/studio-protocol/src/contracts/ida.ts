export const IDA_VIEWS=["overview","pseudocode","asm","functions","strings","imports","exports","xrefs"] as const;
export type IdaView=typeof IDA_VIEWS[number];
export type IdaEdit={action:"open";path:string}|{action:"save";dbId:string}|{action:"close";dbId:string;save:boolean}|{action:"rename";dbId:string;target:string;name:string}|{action:"comment";dbId:string;target:string;text:string;repeatable:boolean}|{action:"set_type";dbId:string;target:string;decl:string}|{action:"make_function";dbId:string;target:string}|{action:"exec";dbId:string;code:string};
export interface IdaRow {id:string;label:string;state:"opening"|"open";dirty:boolean;busy:boolean;identity?:string;version?:number}
export interface IdaState {available:boolean;reason?:string;databases:IdaRow[]}
export type IdaOperation={kind:"ida.status";sessionId:string}|{kind:"ida.view";sessionId:string;dbId:string;identity:string;version:number;view:IdaView;target?:string;offset?:number}|{kind:"ida.prepare";sessionId:string;edit:IdaEdit}|{kind:"ida.commit";sessionId:string;token:string}|{kind:"ida.cancel";sessionId:string};
export interface IdaResultMap {"ida.status":IdaState;"ida.view":{text:string;total:number;offset:number;nextOffset?:number;truncated:boolean};"ida.prepare":{token:string;edit:IdaEdit;identity?:string;version?:number;expiresAt:number};"ida.commit":{text:string};"ida.cancel":{cancelled:boolean}}
export const IDA_KINDS=["ida.status","ida.view","ida.prepare","ida.commit","ida.cancel"] as const;
export function isIdaKind(kind:string):kind is IdaOperation["kind"]{return (IDA_KINDS as readonly string[]).includes(kind);}
