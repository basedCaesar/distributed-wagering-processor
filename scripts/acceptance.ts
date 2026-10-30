const apiBaseUrl = process.env.ACCEPTANCE_API_URL ?? "http://localhost:3000";

async function checkHealth(path: string): Promise<void> {
  const response = await fetch(`${apiBaseUrl}${path}`);
  if (!response.ok) {
    throw new Error(`${path} respondeu ${response.status}`);
  }
  console.log(`${path}: ok`);
}

async function main(): Promise<void> {
  await checkHealth("/health/live");
  await checkHealth("/health/ready");

  // Os exemplos literais do §9 (curl com Authorization) e do §10 (awslocal sqs send-message)
  // entram na S10, junto com Keycloak e os clients de teste.
  console.log("S0: esqueleto de aceitação ok. §9 e §10 entram em S10.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
