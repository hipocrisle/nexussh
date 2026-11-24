"""Loopback-only проверка PowerShell banner probe; не подключается к реальному железу."""
from pathlib import Path
import socket
import subprocess
import threading

script = Path(__file__).resolve().parents[1] / 'scripts/diagnose-ssh-banner.ps1'
for kind in ['both', 'reject-russh', 'closed', 'fragmented']:
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    listener.listen()
    port = listener.getsockname()[1]
    errors = []

    def server():
        try:
            listener.settimeout(15)
            for _ in range(2):
                conn, _ = listener.accept()
                with conn:
                    conn.settimeout(5)
                    message = b''
                    while not message.endswith(b'\n'):
                        chunk = conn.recv(1)
                        if not chunk:
                            raise AssertionError('no client ID')
                        message += chunk
                    assert message in [b'SSH-2.0-russh_0.61.1\r\n', b'SSH-2.0-PuTTY_0.73_RU_17\r\n']
                    if kind == 'both' or (kind == 'reject-russh' and b'PuTTY' in message):
                        conn.sendall(b'SSH-2.0-TestPeer\r\n')
                    elif kind == 'fragmented':
                        for byte in b'notice\r\nSSH-2.0-TestPeer\r\n':
                            conn.sendall(bytes([byte]))
        except Exception as error:
            errors.append(error)
        finally:
            listener.close()

    thread = threading.Thread(target=server)
    thread.start()
    result = subprocess.run(['pwsh', '-NoProfile', '-File', str(script), '-TargetHost',
                             '127.0.0.1', '-Port', str(port)], capture_output=True, text=True, timeout=20)
    thread.join(timeout=15)
    assert not thread.is_alive() and not errors, errors
    assert result.returncode == 0, result.stderr
    assert result.stdout.count('ServerIdReceived') == {'both': 2, 'reject-russh': 1,
                                                       'closed': 0, 'fragmented': 2}[kind], result.stdout
    assert ('ClosedBeforeServerId' in result.stdout) == (kind in ['reject-russh', 'closed'])
    print(kind, 'PASS')
