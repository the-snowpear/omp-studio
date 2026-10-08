import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import {AskBody} from "./AskCard";
import {submitAskValue} from "./askContent";
import {validateAskAnswerPayload} from "@omp-studio/studio-protocol";
afterEach(cleanup);
it("answer and note images serialize under their owning question and separate native fields",()=>{
 const image={type:"image" as const,mimeType:"image/png" as const,data:"AA=="};const questions=[{id:"a",question:"A",options:[],multiple:false},{id:"b",question:"B",options:[],multiple:false}];
 const payload=submitAskValue(questions,{a:{picked:[],custom:"",customInputImages:[image]},b:{picked:["B"],custom:"",note:"note",noteImages:[image]}});validateAskAnswerPayload(payload);
 expect(payload.results[0]).toMatchObject({id:"a",customInput:"[Image #1]",customInputImages:[image]});expect(payload.results[1]).toMatchObject({id:"b",note:"note\n[Image #1]",noteImages:[image]});
 expect(()=>validateAskAnswerPayload({results:[{...payload.results[0],customInputImages:[{...image,data:"A".repeat(300000)}]}]})).toThrow();
});
it("closing or changing a question discards a late image load",async()=>{
 let resolve!:(buffer:ArrayBuffer)=>void;const file=new File(["x"],"x.png",{type:"image/png"});Object.defineProperty(file,"arrayBuffer",{value:()=>new Promise<ArrayBuffer>(r=>{resolve=r;})});const onPatch=vi.fn();
 const props={answer:{picked:[],custom:"text"},onPick:vi.fn(),onCustom:vi.fn(),onSubmit:vi.fn(),onPatch};const view=render(<AskBody key="a" question={{id:"a",question:"A",options:[],acceptImages:true}} {...props}/>);
 fireEvent.change(view.container.querySelector('input[type="file"]')!,{target:{files:[file]}});await waitFor(()=>expect(resolve).toBeTruthy());view.rerender(<AskBody key="b" question={{id:"b",question:"B",options:[],acceptImages:true}} {...props}/>);resolve(new Uint8Array([0]).buffer);await new Promise(r=>setTimeout(r,10));expect(onPatch).not.toHaveBeenCalled();
 expect(screen.getByRole("textbox",{name:"备注 / Note"})).toBeTruthy();
});
