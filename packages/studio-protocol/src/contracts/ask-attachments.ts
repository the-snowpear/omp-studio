/** Same bounded base64 image channel as Composer; no file is created before submission. */
export interface AskImage {type:"image";mimeType:"image/png"|"image/jpeg"|"image/gif"|"image/webp";data:string}
export interface AskAnswerPayload {results:Array<{id:string;selectedOptions:string[];customInput?:string;note?:string;noteOption?:string;customInputImages?:AskImage[];noteImages?:AskImage[]}>}
