import { execFileSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const schemaDir = resolve(dirname(fileURLToPath(import.meta.url)), "../prisma");
const schemaPath = resolve(schemaDir, "schema.prisma");

try {
  execFileSync("bunx", ["prisma@6", "db", "push", "--skip-generate", "--schema", schemaPath], {
    stdio: "inherit",
  });
} catch {
  console.warn("[migrate] prisma db push failed, tables may already exist");
}
