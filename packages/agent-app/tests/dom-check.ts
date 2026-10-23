// Named checks for DOM suites, so a spec case can link to one behaviour (docs/spec/acceptance-cases.md#dom-suites-named-checks).
export async function check(name: string, body: () => unknown | Promise<unknown>): Promise<void> {
  try {
    await body();
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    process.stdout.write(`not ok - ${name}\n`);
    throw error;
  }
}
