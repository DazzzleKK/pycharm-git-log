/* Creates a realistic demo repository for manual / e2e testing. */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const base = process.argv[2] || path.join(os.tmpdir(), 'pcgit-demo');
const repo = path.join(base, 'expert-demo');
const remote = path.join(base, 'expert-remote.git');

fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(remote, { recursive: true });

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Keril',
  GIT_AUTHOR_EMAIL: 'krivinsony@gmail.com',
  GIT_COMMITTER_NAME: 'Keril',
  GIT_COMMITTER_EMAIL: 'krivinsony@gmail.com',
};

let clock = Date.now() / 1000 - 86400 * 3;

function git(args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env });
}

function commit(files, message) {
  for (const [name, text] of Object.entries(files)) {
    const full = path.join(repo, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  git(['add', '-A']);
  clock += 3600 * 5;
  const stamp = new Date(clock * 1000).toISOString();
  execFileSync('git', ['commit', '-m', message], {
    cwd: repo,
    env: { ...env, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp },
    encoding: 'utf8',
  });
}

git(['init', '-b', 'main']);
git(['config', 'user.name', 'Keril']);
git(['config', 'user.email', 'krivinsony@gmail.com']);
git(['init', '--bare', remote]);
git(['remote', 'add', 'origin', remote]);

commit(
  {
    'src/domain/billing/models.py': 'class Invoice:\n    amount: int = 0\n',
    'src/domain/billing/services.py': 'def calculate(invoice):\n    return invoice.amount\n',
    'README.md': '# Expert\n\nBilling service.\n',
  },
  'feat: каркас домена биллинга'
);
commit(
  {
    'src/api/v1/billing/views.py': 'def invoice_detail(request, pk):\n    return {}\n',
    'tests/test_billing.py': 'def test_calculate():\n    assert True\n',
  },
  'feat: API просмотра счёта'
);
commit(
  {
    'src/domain/billing/filters.py': 'def filter_invoices(qs, ids):\n    return qs.filter(id__in=ids)\n',
  },
  'fix: падение при пустом IN (NULL, 1)'
);
commit(
  {
    'pyproject.toml': '[tool.poetry]\nname = "expert"\nversion = "0.1.0"\n',
  },
  'chore: обновить зависимости'
);

git(['tag', '-a', 'v2026.1', '-m', 'Release 2026.1']);
git(['push', '-u', 'origin', 'main']);
git(['push', 'origin', 'v2026.1']);

git(['checkout', '-b', 'feature/payments']);
commit(
  {
    'src/domain/payments/models.py': 'class Payment:\n    amount: int = 0\n',
    'src/domain/payments/services.py': 'def reconcile(payment):\n    return True\n',
  },
  'feat(payments): модель и сервис сверки'
);
commit(
  {
    'src/domain/payments/repositories.py': 'from .models import Payment\n\nclass PaymentRepository:\n    model = Payment\n',
    'src/domain/payments/__init__.py': '',
  },
  'feat(payments): репозиторий сверки'
);
commit(
  {
    'tests/domain/payments/test_reconcile.py': 'def test_reconcile():\n    assert True\n',
  },
  'test: покрыть сверку платежей'
);
git(['push', '-u', 'origin', 'feature/payments']);

git(['checkout', 'main']);
git(['checkout', '-b', 'release/2026.1']);
commit(
  {
    'docs/release-2026.1.md': '# Релиз 2026.1\n\n- сверка платежей\n',
  },
  'docs: описание релиза 2026.1'
);
git(['push', '-u', 'origin', 'release/2026.1']);

git(['checkout', 'main']);
commit(
  {
    'src/api/v1/payments/views.py': 'from domain.payments.services import reconcile\n\ndef reconcile_view(request):\n    return {"ok": reconcile(None)}\n',
  },
  'feat(payments): эндпоинт сверки'
);
git(['merge', '--no-ff', 'feature/payments', '-m', "Merge branch 'feature/payments' into main"]);
git(['merge', '--no-ff', 'release/2026.1', '-m', "Merge branch 'release/2026.1' into main"]);
git(['push', 'origin', 'main']);

git(['checkout', '-b', 'fix/tariff']);
commit(
  {
    'src/domain/billing/tariff.py': 'def round_money(value):\n    return round(value, 2)\n',
  },
  'fix(tariff): округление до копеек'
);
commit(
  {
    'src/workers/queue15.py': 'def run():\n    return "ok"\n',
  },
  'fix: таймаут воркера очереди 15'
);

git(['checkout', 'main']);
git(['checkout', '-b', 'fix/calc-penalty']);
commit(
  {
    'src/domain/billing/penalty.py': 'def penalty(amount, days):\n    return amount * days / 300\n',
  },
  'fix: расчёт пени при досрочном погашении'
);

git(['checkout', 'main']);

console.log(repo);
