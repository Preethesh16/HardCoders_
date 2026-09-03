import { buildApp } from "./app.js";
import { RealAlgorandChain } from "./chain.js";
import { loadConfig } from "./config.js";
import { HttpAuthoritativeFabricReader } from "./security/gateway-reader.js";
import { Ed25519FabricPermitVerifier } from "./security/permit.js";
import { ExecutorService } from "./service.js";
import { PostgresExecutorStore } from "./store.js";

const config = loadConfig();
const store = new PostgresExecutorStore(config);
const service = new ExecutorService(
  config,
  store,
  new Ed25519FabricPermitVerifier(config),
  new HttpAuthoritativeFabricReader(config),
  new RealAlgorandChain(config),
);
await service.initialize();
const app = await buildApp(config, service);
await app.listen({ host: config.HOST, port: config.PORT });
