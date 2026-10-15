const form = document.querySelector('#public-form');
if (form) {
  const answers = () => Object.fromEntries([...form.elements].filter(e => e.name && !e.disabled).map(e => [e.name, e.dataset.type === 'checkbox' ? e.checked : e.dataset.type === 'number' && e.value !== '' ? Number(e.value) : e.value]));
  const visibility = () => {
    const values = answers();
    for (const label of form.querySelectorAll('[data-condition]')) {
      const condition = JSON.parse(label.dataset.condition);
      label.hidden = values[condition.field] !== condition.equals;
      for (const input of label.querySelectorAll('input,select')) input.disabled = label.hidden;
    }
  };
  form.addEventListener('input', visibility);
  visibility();
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('button');
    const status = document.querySelector('#form-status');
    button.disabled = true;
    try {
      const response = await fetch(`/api/forms/${encodeURIComponent(form.dataset.formId)}/submit`, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Fountain-Request': '1'}, body: JSON.stringify({answers: answers()})});
      const result = await response.json();
      if (!response.ok) throw Error(result.message || result.error);
      form.reset(); visibility(); status.textContent = '응답이 제출되었습니다.';
    } catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  });
}
