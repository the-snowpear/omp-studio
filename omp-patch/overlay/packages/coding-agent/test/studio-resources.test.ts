import {test,expect} from "bun:test";
import {mkdtemp,mkdir,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {StudioResourceService} from "../src/studio/services/resource-service";
import {Settings} from "../src/config/settings";
test("native local resources paginate, bind versions and reject traversal and foreign sessions",async()=>{
 const root=await mkdtemp(join(tmpdir(),"studio-resource-"));await mkdir(join(root,"local"));await writeFile(join(root,"local","notes.txt"),Array.from({length:205},(_,i)=>"line "+i).join("\n"));
 const session={sessionId:"s",studioToolSession:{cwd:root,settings:Settings.isolated(),getArtifactsDir:()=>root,getSessionId:()=>"s",getSessionFile:()=>undefined,skills:[],activeRules:[]}};
 const service=new StudioResourceService(session as never);const first=await service.read({kind:"resource.read",sessionId:"s",uri:"local://notes.txt"});expect(first.nextOffset).toBe(100);
 const second=await service.read({kind:"resource.read",sessionId:"s",uri:"local://notes.txt",offset:100,version:first.version});expect(second.text.startsWith("line 100")).toBe(true);
 await writeFile(join(root,"local","notes.txt"),"changed");await expect(service.read({kind:"resource.read",sessionId:"s",uri:"local://notes.txt",offset:100,version:first.version})).rejects.toThrow("changed");
 await expect(service.read({kind:"resource.read",sessionId:"wrong",uri:"omp://"})).rejects.toThrow();await expect(service.read({kind:"resource.read",sessionId:"s",uri:"local://../outside"})).rejects.toThrow();
});
