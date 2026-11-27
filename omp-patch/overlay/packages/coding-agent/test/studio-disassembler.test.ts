import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { cfgBinjaInstallDir, cfgBinjaPython } from "../src/binja/settings";
import { Settings } from "../src/config/settings";
import type { AgentSession } from "../src/session/agent-session";
import { StudioDisassemblerService } from "../src/studio/services/disassembler-service";
import type { DisassemblerStatus } from "../src/studio/disassembler-protocol";
test("native Python fence rejects stale reviews after another actor edits or a mutation fails", async () => {
	const script = `import ast,json,os,sys,threading,time,uuid
source=ast.parse(open(sys.argv[1],encoding='utf8').read())
nodes=[n for n in source.body if isinstance(n,ast.FunctionDef) and n.name in ('_handle','_run','_view_page','_view_list')]
sent=[]
calls=[]
checkpoints=[]
def rename(p): calls.append('rename');return {}
def fail(p): calls.append('comment');raise ValueError('partial failure')
scope={'_STUDIO_VERSION':0,'_STUDIO_IDENTITY':'native','_arm_sigint':lambda:None,'_send':sent.append,'json':json,'_error':lambda e:str(e),'_DIRTY':False,'_METHODS':{'rename':rename,'comment':fail,'view':lambda p:{'text':'one\\ntwo\\nthree'}},'DB':None,'sys':sys,'os':os,'uuid':uuid,'time':time,'_running_lock':threading.Lock(),'_running_id':None,'_interrupt_pending':False,'_INTERRUPT_ABSORB_S':0.02,'_idb_path':lambda:os.path.abspath('fixture.i64'),'_rpc_save':checkpoints.append}
exec(compile(ast.Module(body=nodes,type_ignores=[]),'<ida-fence>','exec'),scope)
def call(method,params): scope['_handle'](json.dumps({'id':1,'method':method,'params':params}));return sent[-1]
assert call('rename',{})['ok']
assert calls==['rename']
assert not call('studio',{'method':'rename','identity':'native','version':0})['ok']
assert not call('studio',{'method':'comment','identity':'native','version':1})['ok']
assert calls==['rename','comment'] and len(checkpoints)==1
assert scope['_STUDIO_VERSION']==2
assert not call('studio',{'method':'rename','identity':'other','version':2})['ok']
page=call('studio',{'method':'view','identity':'native','version':2,'offset':1,'limit':1})['result']['result']
assert page['text']=='two' and page['nextOffset']==2
assert not call('studio',{'method':'view','identity':'native','version':2,'offset':99})['ok']
from types import SimpleNamespace
reads=[]
items=[SimpleNamespace(address=index,length=4,internal_type=0) for index in range(1000)]
scope['_db']=lambda:SimpleNamespace(strings=SimpleNamespace(get_all=lambda:iter(items)))
def read_string(address,length,kind): reads.append(address);return b'test'
scope['ida_bytes']=SimpleNamespace(get_strlit_contents=read_string)
page=call('studio',{'method':'view','identity':'native','version':2,'params':{'kind':'strings'},'offset':500,'limit':2})['result']['result']
assert reads==[500,501] and page['total']==1000 and page['nextOffset']==502
assert page['text']=='0x1f4  "test"\\n0x1f5  "test"'
assert calls==['rename','comment']
print('fence and exactly-once execution passed')
`;
	const child = Bun.spawn(
		[
			"python",
			"-c",
			script,
			new URL("../src/ida/worker.py", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const err = await new Response(child.stderr).text();
	expect(await child.exited, err).toBe(0);
});

test("Binary Ninja worker Studio seam enforces fence, creates checkpoints, and paginates views", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-binja-worker-"));
	try {
		const dbFile = path.join(dir, "fixture.bndb");
		await fs.writeFile(dbFile, "db-v0");
		const script = `import ast,json,os,shutil,sys,tempfile,uuid
from types import SimpleNamespace
source=ast.parse(open(sys.argv[1],encoding='utf8').read())
wanted={'_view_list','_view_page','_rpc_save','_bump_studio_version','_rpc_studio'}
nodes=[n for n in source.body if isinstance(n,ast.FunctionDef) and n.name in wanted]
calls=[]
class FakeFile:
    modified=False
    analysis_changed=False
class FakeBv:
    file=FakeFile()
    def save_auto_snapshot(self):
        with open(scope['_DATABASE_PATH'],'wb') as f:
            f.write(b'db-flushed')
        return True
bv_inst=FakeBv()
def fake_rename(target, name):
    calls.append(('rename', target, name))
    return {'renamed': target}
def fake_comment(target, text, repeatable=False):
    calls.append(('comment', target, text))
    raise ValueError('partial binja failure')
def fake_exec(p):
    calls.append(('exec', p.get('code')))
    return {'output': 'ok\\n', 'value': '1', 'error': None}
func_rows=[SimpleNamespace(start=0x1000+i,name=f'fn_{i}') for i in range(5)]
str_rows=[SimpleNamespace(start=0x2000+i,value=f'str_{i}') for i in range(4)]
scope={
    'os':os,'json':json,'shutil':shutil,'uuid':uuid,
    '_STUDIO_IDENTITY':'binja-native','_STUDIO_VERSION':0,
    '_DATABASE_PATH':sys.argv[2],'_EXEC_SINCE_SAVE':False,
    'BV':bv_inst,'_bv':lambda:bv_inst,
    '_funcs':lambda:func_rows,
    'imports':lambda:[(0x3000,'KERNEL32','ExitProcess'),(0x3004,None,'puts')],
    '_exports':lambda:[(0x4000,'main'),(0x4010,'helper')],
    '_strings':lambda:str_rows,
    '_rpc_view':lambda p:{'text':'line0\\nline1\\nline2'},
    '_rpc_exec':fake_exec,
    'rename':fake_rename,
    'comment':fake_comment,
    'set_type':lambda t,d:{},
    'make_function':lambda t:{},
}
exec(compile(ast.Module(body=nodes,type_ignores=[]),'<binja-fence>','exec'),scope)
def mutation(fn): return lambda params: fn(params)
scope['_STUDIO_METHODS']={
    'view':scope['_rpc_view'],
    'exec':scope['_rpc_exec'],
    'rename':lambda p:fake_rename(p['target'],p['name']),
    'comment':lambda p:fake_comment(p['target'],p['text']),
    'save':scope['_rpc_save'],
}
scope['_METHODS']={
    'rename':scope['_bump_studio_version'](scope['_STUDIO_METHODS']['rename']),
    'comment':scope['_bump_studio_version'](scope['_STUDIO_METHODS']['comment']),
    'studio':scope['_rpc_studio'],
}

status=scope['_METHODS']['studio']({'method':'status'})
assert status=={'identity':'binja-native','version':0,'result':{}}

# Non-studio rename invalidates version 0 -> 1
scope['_METHODS']['rename']({'target':'sub_1000','name':'entry'})
assert scope['_STUDIO_VERSION']==1
try:
    scope['_METHODS']['studio']({'method':'rename','identity':'binja-native','version':0,'params':{'target':'sub_1000','name':'x'}})
    raise AssertionError('stale version must fail')
except ValueError:
    pass

# Wrong identity rejected
try:
    scope['_METHODS']['studio']({'method':'rename','identity':'other','version':1,'params':{'target':'a','name':'b'}})
    raise AssertionError('wrong identity must fail')
except ValueError:
    pass

# Failed Studio mutation still advances version and saves before-flush + checkpoint backups
try:
    scope['_METHODS']['studio']({'method':'comment','identity':'binja-native','version':1,'params':{'target':'sub_1000','text':'note'}})
    raise AssertionError('failing comment must raise')
except ValueError:
    pass
assert scope['_STUDIO_VERSION']==2
backups=[f for f in os.listdir(os.path.dirname(sys.argv[2])) if '.studio-' in f]
assert any(f.endswith('.backup') for f in backups)
assert any(f.endswith('.backup.before-flush') for f in backups)

# Successful Studio exec bumps version and returns checkpoint + output
exec_res=scope['_METHODS']['studio']({'method':'exec','identity':'binja-native','version':2,'params':{'code':'1'}})
assert exec_res['version']==3
assert exec_res['result']['result']['value']=='1'
assert os.path.isfile(exec_res['result']['backup'])

# Paginated views (overview + lazy lists)
ov=scope['_METHODS']['studio']({'method':'view','identity':'binja-native','version':3,'params':{'kind':'overview'},'offset':1,'limit':1})['result']
assert ov['text']=='line1' and ov['nextOffset']==2 and ov['total']==3
fn_page=scope['_METHODS']['studio']({'method':'view','identity':'binja-native','version':3,'params':{'kind':'functions'},'offset':2,'limit':2})['result']
assert fn_page['text']=='0x1002  fn_2\\n0x1003  fn_3' and fn_page['total']==5 and fn_page['nextOffset']==4
imp_page=scope['_METHODS']['studio']({'method':'view','identity':'binja-native','version':3,'params':{'kind':'imports'},'offset':0,'limit':2})['result']
assert imp_page['text']=='0x3000  KERNEL32!ExitProcess\\n0x3004  puts' and 'nextOffset' not in imp_page
str_page=scope['_METHODS']['studio']({'method':'view','identity':'binja-native','version':3,'params':{'kind':'strings'},'offset':1,'limit':2})['result']
assert str_page['text']=='0x2001  "str_1"\\n0x2002  "str_2"' and str_page['nextOffset']==3
try:
    scope['_METHODS']['studio']({'method':'view','identity':'binja-native','version':3,'params':{'kind':'strings'},'offset':99,'limit':1})
    raise AssertionError('out-of-range offset must fail')
except ValueError:
    pass
print('binja seam passed')
`;
		const child = Bun.spawn(
			[
				"python",
				"-c",
				script,
				new URL("../src/binja/worker.py", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
				dbFile,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const err = await new Response(child.stderr).text();
		expect(await child.exited, err).toBe(0);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("StudioDisassemblerService configures binja backend and reports binja status", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-binja-service-"));
	try {
		const fakeInstall = path.join(dir, "binja-install");
		const pkgDir = path.join(fakeInstall, "python", "binaryninja");
		await fs.mkdir(pkgDir, { recursive: true });
		const coreLibrary =
			process.platform === "win32"
				? "binaryninjacore.dll"
				: process.platform === "darwin"
					? "libbinaryninjacore.dylib"
					: "libbinaryninjacore.so.1";
		await fs.writeFile(path.join(fakeInstall, coreLibrary), "");
		await fs.writeFile(
			path.join(pkgDir, "__init__.py"),
			"class BinaryView:\n    @staticmethod\n    def new(_data):\n        return object()\n",
		);
		const sampleExe = path.join(dir, "sample.bin");
		await fs.writeFile(sampleExe, "not-a-real-binary");

		const settings = Settings.isolated();
		const service = new StudioDisassemblerService({
			sessionId: "disasm-test",
			cwd: dir,
			sessionManager: { getCwd: () => dir },
			studioToolSession: { cwd: dir, settings },
			settings,
		} as unknown as AgentSession);

		// Missing install dir makes binja backend unavailable and prevents silent UI rejection on open.
		cfgBinjaInstallDir.set(settings, path.join(dir, "nonexistent-binja"));
		const configured = (await service.execute({
			kind: "disassembler.configure",
			sessionId: "disasm-test",
			backend: "binja",
			maxOpen: 4,
			idleCloseSec: 900,
		})) as DisassemblerStatus;
		expect(configured.backend).toBe("binja");
		expect(configured.activeBackend).toBeUndefined();
		expect(configured.backends.binja.state).toBe("unavailable");
		expect(configured.available).toBe(false);

		// When backend is none, open enforces metadata-only error.
		await service.execute({
			kind: "disassembler.configure",
			sessionId: "disasm-test",
			backend: "none",
			maxOpen: 4,
			idleCloseSec: 900,
		});
		await expect(
			service.execute({ kind: "disassembler.open", sessionId: "disasm-test", path: sampleExe }),
		).rejects.toThrow(/metadata only|头部元数据/);

		// Pointing binja.installDir and binja.python at a runnable Python with stub binaryninja marks binja ready.
		const pythonExe = Bun.which("python3") ?? Bun.which("python");
		if (pythonExe) {
			const ready = (await service.execute({
				kind: "disassembler.configure",
				sessionId: "disasm-test",
				backend: "binja",
				binjaInstallDir: fakeInstall,
				binjaPython: pythonExe,
				maxOpen: 4,
				idleCloseSec: 900,
			})) as DisassemblerStatus;
			expect(ready.backend).toBe("binja");
			expect(ready.activeBackend).toBe("binja");
			expect(ready.backends.binja).toEqual({ state: "ready", detail: pythonExe });
			expect(ready.available).toBe(true);
		}
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});
