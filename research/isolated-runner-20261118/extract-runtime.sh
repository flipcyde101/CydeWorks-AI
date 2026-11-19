set -eu

dpkg-deb --fsys-tarfile bubblewrap_0.9.0-1ubuntu0.3_amd64.deb | tar --extract --to-stdout ./usr/bin/bwrap > runner-bwrap
tar --extract --gzip --file opencode-linux-x64-1.18.34.tgz --to-stdout package/bin/opencode > runner-opencode
test -s runner-bwrap
test -s runner-opencode
test -x runner-bwrap
test -x runner-opencode
./runner-bwrap --version
sha256sum runner-bwrap runner-opencode
