import { test, expect } from "bun:test";
import { StudioIdaService, type StudioIdaDb, type StudioIdaPort } from "../src/studio/services/ida-service";
test("IDA mutations require a single-use review and native database identity/version", async () => {
	let version = 1;
	const calls: string[] = [];
	const db: StudioIdaDb = {
		id: "db",
		label: "binary",
		state: "open",
		dirty: false,
		busy: false,
		request: async raw => {
			const p = raw as { method: string; identity: string; version: number };
			calls.push(p.method);
			if (p.method !== "status") {
				if (p.identity !== "instance" || p.version !== version) throw Error("stale");
				version++;
			}
			return { identity: "instance", version, result: { ok: true } };
		},
	};
	const port: StudioIdaPort = {
		available: async () => {},
		list: async () => [db],
		open: async () => {
			throw Error("unexpected open");
		},
	};
	const service = new StudioIdaService(
		{ sessionId: "s", sessionManager: { getCwd: () => process.cwd() } } as never,
		port,
	);
	const quote = (await service.execute({
		kind: "ida.prepare",
		sessionId: "s",
		edit: { action: "rename", dbId: "db", target: "main", name: "entry" },
	})) as { token: string };
	expect(calls).toEqual(["status"]);
	version++;
	await expect(service.execute({ kind: "ida.commit", sessionId: "s", token: quote.token })).rejects.toThrow("stale");
	await expect(service.execute({ kind: "ida.commit", sessionId: "s", token: quote.token })).rejects.toThrow("expired");
	const fresh = (await service.execute({
		kind: "ida.prepare",
		sessionId: "s",
		edit: { action: "save", dbId: "db" },
	})) as { token: string };
	await service.execute({ kind: "ida.commit", sessionId: "s", token: fresh.token });
	expect(calls.at(-1)).toBe("save");
	await expect(service.execute({ kind: "ida.status", sessionId: "wrong" })).rejects.toThrow("Session changed");
	service.dispose();
});
test("IDA absent state is explicit and never installs software", async () => {
	let touched = false;
	const service = new StudioIdaService({ sessionId: "s" } as never, {
		available: async () => {
			throw Error("IDA not installed");
		},
		list: async () => {
			touched = true;
			return [];
		},
		open: async () => {
			touched = true;
		},
	});
	expect(await service.execute({ kind: "ida.status", sessionId: "s" })).toEqual({
		available: false,
		reason: "IDA not installed",
		databases: [],
	});
	expect(touched).toBe(false);
});
test("native Python fence rejects stale reviews after another actor edits or a mutation fails", async () => {
	const script = `import ast,json,os,sys,threading,time,uuid
source=ast.parse(open(sys.argv[1],encoding='utf8').read())
nodes=[n for n in source.body if isinstance(n,ast.FunctionDef) and n.name in ('_handle','_run')]
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
