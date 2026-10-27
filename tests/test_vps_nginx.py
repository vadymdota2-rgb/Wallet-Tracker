"""nginx для своего сервера (tools/vps_nginx.py): npm test.

Конфиг для VPS делается из nginx.conf контейнера — проверяем, что каждая
замена на месте, а то, что на своём сервере опасно (адрес человека из
X-Forwarded-For, который он пишет сам), не переехало.
"""
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import vps_nginx  # noqa: E402

KEY = "k3y-For-Tests_0123456789"


def conf() -> str:
    with open(os.path.join(ROOT, "nginx.conf"), encoding="utf-8") as f:
        return f.read()


class VpsNginxTest(unittest.TestCase):
    def test_https_domain_cache_root_and_key(self):
        out = vps_nginx.build(conf(), "wt.example.com", KEY, "/home/u/WalletTracker/html")
        self.assertIn("listen 443 ssl http2;", out)
        self.assertIn("server_name wt.example.com;", out)
        self.assertIn("ssl_certificate /etc/letsencrypt/live/wt.example.com/fullchain.pem;", out)
        self.assertIn("root /home/u/WalletTracker/html;", out)
        self.assertNotIn("listen 8080", out)
        self.assertNotIn("proxy_cache_path /tmp", out)
        self.assertNotIn("__API_KEY__", out)
        self.assertEqual(out.count(KEY), conf().count("__API_KEY__"))
        # 80 — только certbot и перенаправление.
        self.assertIn("return 301 https://$host$request_uri;", out)
        self.assertIn("/.well-known/acme-challenge/", out)

    def test_client_address_is_not_taken_from_x_forwarded_for(self):
        # На своём сервере X-Forwarded-For пишет сам человек: адрес оттуда —
        # подделка, обходящая нормы. Только $remote_addr.
        out = vps_nginx.build(conf(), "wt.example.com", KEY, "/srv/html")
        self.assertNotIn("$http_x_forwarded_for $client_ip", out)
        self.assertIn("map $remote_addr $client_ip {\n    default $remote_addr;\n}", out)

    def test_changed_nginx_conf_stops_with_an_error(self):
        for old in ("listen 8080;", "proxy_cache_path /tmp/klcache", "map $http_x_forwarded_for $client_ip {", "__API_KEY__"):
            with self.assertRaises(SystemExit, msg=old):
                vps_nginx.build(conf().replace(old, "x"), "wt.example.com", KEY, "/srv/html")

    def test_bad_domain_and_key_are_refused(self):
        with tempfile.TemporaryDirectory() as d:
            env = os.path.join(d, "env")
            for key, ok in ((KEY, True), ("", False), ("short", False), ('a"b;c' * 5, False)):
                with open(env, "w", encoding="utf-8") as f:
                    f.write(f"OTHER=1\nWHALE_API_KEY={key}\n")
                r = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "vps_nginx.py"), "wt.example.com", "--env", env],
                                   capture_output=True, text=True, check=False)
                self.assertEqual(r.returncode == 0, ok, (key, r.stderr))
            for dom in ("bad domain", "x", "evil.com;\nserver{", "-a.com"):
                r = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "vps_nginx.py"), dom, "--env", env],
                                   capture_output=True, text=True, check=False)
                self.assertNotEqual(r.returncode, 0, dom)


if __name__ == "__main__":
    unittest.main()
