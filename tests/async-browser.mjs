/** Poll the resolved browser value, never the truthiness of a pending Promise. */
export async function waitForAsync(page, predicate, argument, { timeout = 15000 } = {}) {
  const deadline = Date.now() + timeout;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Timed out waiting for the resolved browser condition');
    let timer;
    let value;
    try {
      value = await Promise.race([
        page.evaluate(predicate, argument),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out waiting for the resolved browser condition')), remaining); })
      ]);
    } finally { clearTimeout(timer); }
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(0, deadline - Date.now()))));
  }
}
