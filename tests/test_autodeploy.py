"""Автовыкат на своём сервере (tools/autodeploy.sh): npm test.

Настоящие git-репозитории во временной папке («GitHub» — голый репозиторий,
«сервер» — его клон), а root-команды — подставные: setpriv просто исполняет
команду, systemctl и nginx пишут, что их вызвали, и отвечают так, как велит
тест. Проверяем, что выкатывается нужное и что сломанное откатывается само
и не выкатывается снова раз в минуту.
"""
import os
import shutil
import subprocess
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "tools", "autodeploy.sh")
INSTALL = os.path.join(ROOT, "tools", "autodeploy-install.sh")
KEY = "k3y-For-Tests_0123456789"

FAKES = {
    "setpriv": '#!/bin/sh\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n',
    "systemctl": (
        '#!/bin/sh\necho "$*" >>"$FAKE_LOG"\n'
        'if [ "$1" = is-active ] && [ -f "$FAKE_DIR/down-$3" ]; then exit 3; fi\nexit 0\n'),
    "nginx": '#!/bin/sh\necho "nginx $*" >>"$FAKE_LOG"\n[ -f "$FAKE_DIR/nginx-bad" ] && exit 1\nexit 0\n',
}

BUILD = """#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
grep -q BROKEN main.cpp && { echo "main.cpp:1: error" >&2; exit 1; }
cp main.cpp "${1:-whale_bot}"
"""


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


class AutodeployTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        t = self.tmp
        self.fake = os.path.join(t, "fake")
        os.makedirs(self.fake)
        for name, body in FAKES.items():
            path = os.path.join(self.fake, name)
            with open(path, "w", encoding="utf-8") as f:
                f.write(body)
            os.chmod(path, 0o700)
        self.log = os.path.join(t, "calls.log")
        open(self.log, "w").close()
        self.home = os.path.join(t, "home")
        self.site = os.path.join(t, "site.conf")
        with open(self.site, "w", encoding="utf-8") as f:
            f.write("old site\n")
        self.env_file = os.path.join(t, "whale-api.env")
        with open(self.env_file, "w", encoding="utf-8") as f:
            f.write(f"WHALE_API_KEY={KEY}\n")

        self.dev = {}
        for name, files in (
            ("WalletTracker", {
                "whale_api.py": "X = 1\n",
                "html/index.html": "<p>1</p>\n",
                "nginx.conf": read(os.path.join(ROOT, "nginx.conf")),
                "tools/vps_nginx.py": read(os.path.join(ROOT, "tools", "vps_nginx.py")),
            }),
            ("WhaleScanner", {"main.cpp": "v1\n", "build.sh": BUILD}),
        ):
            bare = os.path.join(t, "github", name + ".git")
            git(t, "init", "-q", "--bare", "-b", "main", bare)
            dev = os.path.join(t, "dev", name)
            git(t, "clone", "-q", bare, dev)
            self._write(dev, files)
            if name == "WhaleScanner":
                os.chmod(os.path.join(dev, "build.sh"), 0o700)
            self._commit(dev, "start")
            git(t, "clone", "-q", bare, os.path.join(self.home, name))
            self.dev[name] = dev
        subprocess.run([os.path.join(self.home, "WhaleScanner", "build.sh")], check=True)

    def _write(self, repo, files):
        for rel, body in files.items():
            path = os.path.join(repo, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                f.write(body)

    def _commit(self, repo, msg):
        git(repo, "add", "-A")
        git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg)
        git(repo, "push", "-q", "origin", "HEAD:main")
        return git(repo, "rev-parse", "HEAD")

    def push(self, name, files):
        self._write(self.dev[name], files)
        return self._commit(self.dev[name], "change")

    def run_deploy(self, domain="wt.example.com"):
        env = dict(os.environ, PATH=self.fake + os.pathsep + os.environ["PATH"], FAKE_LOG=self.log,
                   FAKE_DIR=self.fake, WT_HOME=self.home, WT_STATE=os.path.join(self.tmp, "state"),
                   WT_NGINX_SITE=self.site, WT_API_ENV=self.env_file, WT_SETTLE="0", WT_DOMAIN=domain)
        r = subprocess.run(["bash", SCRIPT], env=env, capture_output=True, text=True, check=False)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        calls = read(self.log)
        open(self.log, "w").close()
        return r.stdout, calls

    def head(self, name):
        return git(os.path.join(self.home, name), "rev-parse", "HEAD")

    def bot(self):
        return read(os.path.join(self.home, "WhaleScanner", "whale_bot"))

    def test_nothing_new_touches_nothing(self):
        out, calls = self.run_deploy()
        self.assertEqual((out, calls), ("", ""))

    def test_pages_only_need_no_restart(self):
        new = self.push("WalletTracker", {"html/index.html": "<p>2</p>\n"})
        _, calls = self.run_deploy()
        self.assertEqual(self.head("WalletTracker"), new)
        self.assertEqual(calls, "")

    def test_server_change_restarts_api(self):
        new = self.push("WalletTracker", {"whale_api.py": "X = 2\n"})
        out, calls = self.run_deploy()
        self.assertEqual(self.head("WalletTracker"), new)
        self.assertIn("restart whale-api", calls)
        self.assertIn("whale-api перезапущен", out)

    def test_syntax_error_rolls_back_once_and_next_commit_goes(self):
        old = self.head("WalletTracker")
        self.push("WalletTracker", {"whale_api.py": "def (:\n"})
        out, calls = self.run_deploy()
        self.assertEqual(self.head("WalletTracker"), old)
        self.assertNotIn("restart", calls)
        self.assertIn("ошибка синтаксиса", out)
        # Через минуту — тот же сломанный коммит: ни выката, ни отката.
        self.assertEqual(self.run_deploy(), ("", ""))
        fixed = self.push("WalletTracker", {"whale_api.py": "X = 3\n"})
        _, calls = self.run_deploy()
        self.assertEqual(self.head("WalletTracker"), fixed)
        self.assertIn("restart whale-api", calls)

    def test_api_that_does_not_come_up_is_rolled_back(self):
        old = self.head("WalletTracker")
        self.push("WalletTracker", {"whale_api.py": "X = 4\n"})
        open(os.path.join(self.fake, "down-whale-api"), "w").close()
        out, calls = self.run_deploy()
        self.assertEqual(self.head("WalletTracker"), old)
        self.assertEqual(calls.count("restart whale-api"), 2)
        self.assertIn("не поднялся", out)

    def test_nginx_config_is_rebuilt_and_bad_one_is_reverted(self):
        conf = read(os.path.join(self.dev["WalletTracker"], "nginx.conf"))
        self.push("WalletTracker", {"nginx.conf": conf + "# new\n"})
        out, calls = self.run_deploy()
        site = read(self.site)
        self.assertIn("server_name wt.example.com;", site)
        self.assertIn(KEY, site)
        self.assertIn("reload nginx", calls)
        self.assertIn("nginx обновлён", out)

        open(os.path.join(self.fake, "nginx-bad"), "w").close()
        self.push("WalletTracker", {"nginx.conf": conf + "# newer\n"})
        out, calls = self.run_deploy()
        self.assertEqual(read(self.site), site)
        self.assertNotIn("reload", calls)
        self.assertIn("оставил прежний", out)

    def test_nginx_untouched_without_domain(self):
        conf = read(os.path.join(self.dev["WalletTracker"], "nginx.conf"))
        self.push("WalletTracker", {"nginx.conf": conf + "# new\n"})
        _, calls = self.run_deploy(domain="")
        self.assertEqual(read(self.site), "old site\n")
        self.assertEqual(calls, "")

    def test_bot_change_is_built_and_restarted(self):
        new = self.push("WhaleScanner", {"main.cpp": "v2\n"})
        out, calls = self.run_deploy()
        self.assertEqual(self.head("WhaleScanner"), new)
        self.assertEqual(self.bot(), "v2\n")
        self.assertIn("restart whalescanner", calls)
        self.assertIn("пересобран", out)

    def test_bot_that_does_not_build_keeps_running_old(self):
        old = self.head("WhaleScanner")
        self.push("WhaleScanner", {"main.cpp": "BROKEN\n"})
        out, calls = self.run_deploy()
        self.assertEqual(self.head("WhaleScanner"), old)
        self.assertEqual(self.bot(), "v1\n")
        self.assertNotIn("restart", calls)
        self.assertIn("не собрался", out)
        self.assertFalse(os.path.exists(os.path.join(self.home, "WhaleScanner", "whale_bot.new")))

    def test_bot_that_does_not_come_up_gets_old_binary_back(self):
        old = self.head("WhaleScanner")
        self.push("WhaleScanner", {"main.cpp": "v3\n"})
        open(os.path.join(self.fake, "down-whalescanner"), "w").close()
        out, calls = self.run_deploy()
        self.assertEqual(self.head("WhaleScanner"), old)
        self.assertEqual(self.bot(), "v1\n")
        self.assertEqual(calls.count("restart whalescanner"), 2)
        self.assertIn("не поднялся", out)

    def test_bot_docs_change_needs_no_rebuild(self):
        self.push("WhaleScanner", {"README.md": "docs\n"})
        _, calls = self.run_deploy()
        self.assertEqual(calls, "")

    def test_installer_refuses_bad_domain(self):
        for dom in ("", "bad domain", "x", "evil.com;rm -rf /", "-a.com"):
            r = subprocess.run(["bash", INSTALL, dom], capture_output=True, text=True, check=False)
            self.assertEqual(r.returncode, 2, dom)


if __name__ == "__main__":
    unittest.main()
