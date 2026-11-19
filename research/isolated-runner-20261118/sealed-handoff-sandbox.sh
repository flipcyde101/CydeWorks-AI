#!/bin/sh
# Run the sealed handoff Python tests in an offline Linux sandbox.
# Usage (from Windows): wsl.exe -d Ubuntu-24.04 --user nobody --exec sh <this file> <wsl path of this folder> [command]
# Boundary: unprivileged user, private user/net/mount/pid namespaces, loopback only,
# read-only source bind, tmpfs scratch, host drive mounts hidden, CPU/memory/file/process
# limits and a wall-clock timeout. The probe step fails the run if any boundary is missing.
set -eu
SRC=$1
MODE=${2:-test}
exec timeout -k 5 180 prlimit --as=1073741824 --cpu=120 --fsize=67108864 --nofile=256 --nproc=128 -- \
  unshare --user --map-root-user --net --mount --pid --fork --mount-proc --propagation private \
  sh -eu -c '
SRC=$1; MODE=$2
mount -t tmpfs -o size=64m,mode=0700 tmpfs /tmp
mkdir /tmp/src /tmp/scratch
mount --bind "$SRC" /tmp/src
mount -o remount,bind,ro /tmp/src
for d in /mnt /dev/shm /var/tmp /run/lock /var/crash /run/user; do
  [ -d "$d" ] && mount -t tmpfs -o size=1m,ro tmpfs "$d" || true
done
fail() { echo "SANDBOX_PROBE_FAILED $1" >&2; exit 97; }
for p in /tmp/src / /usr /etc /home /root /var /opt /mnt /dev/shm; do
  if ( : > "$p/.cw-probe" ) 2>/dev/null; then fail "writable:$p"; fi
done
[ -z "$(ls -A /mnt)" ] || fail "host-mounts-visible"
python3 -I -B -c "import socket,sys
s=socket.socket(); s.settimeout(2)
try: s.connect((\"1.1.1.1\",53))
except OSError: sys.exit(0)
sys.exit(1)" || fail "network-reachable"
[ "$(grep -c : /proc/net/dev)" = 1 ] || fail "non-loopback-interface"
echo SANDBOX_PROBE_OK
cd /tmp/scratch
export TMPDIR=/tmp/scratch PYTHONDONTWRITEBYTECODE=1
case "$MODE" in
  test) exec python3 -I -B /tmp/src/test_sealed_handoff.py -v ;;
  vector) exec python3 -I -B -c "import importlib.util,hashlib,json
spec=importlib.util.spec_from_file_location(\"s\",\"/tmp/src/sealed_handoff.py\"); s=importlib.util.module_from_spec(spec); spec.loader.exec_module(s)
d=lambda b: hashlib.sha256(b).digest()
b=s.build_bundle([s.SealedEntry(2,\"limits.py\",6,d(b\"limit\n\"),b\"limit\n\"),s.SealedEntry(1,\"pkg\"),s.SealedEntry(2,\"pkg/m.py\",2,d(b\"m\n\"),b\"m\n\")])
print(json.dumps({\"sealDigest\":b.seal_digest,\"hex\":s.encode_bundle(b).hex(),\"files\":{k:v.decode() for k,v in b.files().items()}}))" ;;
  *) fail "unknown-mode" ;;
esac
' sandbox "$SRC" "$MODE"
