/**
 * Identical transport contract suite invoked for both P0 adapters.
 *
 * `runTransportContract` registers the same assertion tree for the desktop
 * and web factories, so both adapters execute byte-for-byte the same
 * checks. The call sites below are also compile-time pins: each adapter's
 * API type must accept the shared `ContractFixtureApi` shape.
 */

import { createDesktopTransport } from "@omp-studio/transport-desktop";
import { createWebTransport } from "@omp-studio/transport-web";

import { runTransportContract } from "../src/index.js";

runTransportContract("desktop", (api) => createDesktopTransport(api));
runTransportContract("web", (api) => createWebTransport(api));
