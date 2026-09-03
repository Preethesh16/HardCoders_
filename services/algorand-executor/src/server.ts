import { buildApp } from "./app.js";
import { RealAlgorandChain } from "./chain.js";
import { loadConfig } from "./config.js";
import { FileFabricEvidenceReader, HttpFabricEvidenceReader } from "./security/fabric-evidence-reader.js";
import { HttpAuthoritativeFabricReader } from "./security/gateway-reader.js";
import { Ed25519FabricPermitVerifier } from "./security/permit.js";
import { ExecutorService } from "./service.js";
import { PostgresExecutorStore } from "./store.js";

const config = loadConfig();
const store = new PostgresExecutorStore(config);
const gatewayReader = new HttpAuthoritativeFabricReader(config);
// The offline demo profile reads approved work evidence from a shared fixture
// file; every other profile reads it from the real Fabric Gateway.
const evidenceReader = config.FABRIC_EVIDENCE_MODE === "mock"
  ? new FileFabricEvidenceReader(config.FABRIC_EVIDENCE_FIXTURE_PATH!)
  : new HttpFabricEvidenceReader(config, () => gatewayReader.bearerToken());
const service = new ExecutorService(
  config,
  store,
  new Ed25519FabricPermitVerifier(config),
  gatewayReader,
  new RealAlgorandChain(config),
  evidenceReader,
);
await service.initialize();
const app = await buildApp(config, service);
await app.listen({ host: config.HOST, port: config.PORT });
