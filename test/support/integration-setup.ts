import { migrateUp } from "../../migrations/migrator";
import { credentialsFor } from "./db";

// Preload dos testes com banco: aplica as migrations pendentes com o papel
// dono (D7.3). Os testes rodam com o papel da app e ids únicos, então não
// há limpeza entre arquivos (o ledger não aceita DELETE nem TRUNCATE).
await migrateUp(await credentialsFor("owner"));
