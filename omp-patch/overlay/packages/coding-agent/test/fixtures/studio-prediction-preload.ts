import { spyOn } from "bun:test";
import * as foreign from "../../src/predict/foreign-history";
spyOn(foreign, "readForeignPrompts").mockImplementation(async () => {
	const probe = Bun.env.STUDIO_PREDICT_SEED_PROBE;
	if (probe) await Bun.write(probe, "foreign bootstrap was called");
	return ["external history fixture must not be auto imported"];
});
