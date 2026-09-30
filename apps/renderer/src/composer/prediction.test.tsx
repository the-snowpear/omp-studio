import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createRef } from "react";
import { ChipComposer, type ChipComposerHandle } from "./ChipComposer";
import type { PredictionResult } from "@omp-studio/studio-protocol";
afterEach(()=>{cleanup();vi.restoreAllMocks();});
function type(editor:HTMLElement,text:string){editor.textContent=text;editor.focus();const selection=window.getSelection()!;const range=document.createRange();range.setStart(editor.firstChild!,text.length);range.collapse(true);selection.removeAllRanges();selection.addRange(range);fireEvent.input(editor);}
function rangeRects(){Object.defineProperty(Range.prototype,"getBoundingClientRect",{configurable:true,value:()=>({left:0,right:10,top:0,bottom:20,width:10,height:20})});}
it("debounces queries, keeps ghost text outside the document and accepts Tab",async()=>{
 rangeRects();const ref=createRef<ChipComposerHandle>();const predict=vi.fn(async(_before:string,_prefix:string,version:number)=>({version,suffix:"lo",engine:"ngram" as const}));
 const {container}=render(<ChipComposer ref={ref} predict={predict}/>);const editor=container.querySelector<HTMLElement>(".chip-composer-editor")!;type(editor,"hel");expect(predict).not.toHaveBeenCalled();
 await waitFor(()=>expect(container.querySelector("[data-prediction]")?.textContent).toBe("lo"));expect(ref.current?.getSnapshot().text).toBe("hel");
 fireEvent.keyDown(editor,{key:"Tab"});expect(ref.current?.getSnapshot().text).toBe("hello");
});
it("composition never queries or submits, and late results cannot overwrite a newer document",async()=>{
 rangeRects();let answer:((value:PredictionResult)=>void)|undefined;let queryVersion=0;
 const predict=vi.fn((_before:string,_prefix:string,version:number)=>{queryVersion=version;return new Promise<PredictionResult>(resolve=>{answer=resolve;});});const onSubmit=vi.fn();
 const {container}=render(<ChipComposer predict={predict} onSubmit={onSubmit}/>);const editor=container.querySelector<HTMLElement>(".chip-composer-editor")!;
 fireEvent.compositionStart(editor);type(editor,"中");fireEvent.keyDown(editor,{key:"Enter",isComposing:true});await act(()=>new Promise(resolve=>setTimeout(resolve,230)));expect(predict).not.toHaveBeenCalled();expect(onSubmit).not.toHaveBeenCalled();
 fireEvent.compositionEnd(editor);type(editor,"hel");await waitFor(()=>expect(predict).toHaveBeenCalledTimes(1));type(editor,"new");
 await act(async()=>answer?.({version:queryVersion,suffix:"OLD",engine:"ngram"}));expect(container.querySelector("[data-prediction]")).toBeNull();
});
