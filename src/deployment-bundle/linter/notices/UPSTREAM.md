# Portable local BSL tooling

The package contains unmodified Eclipse Temurin JRE 21.0.13+9 (Windows x64,
HotSpot) and the unmodified BSL Language Server 1.0.7 executable JAR.
No user Java installation, global PATH, JAVA_HOME or registry configuration is
copied or changed. BSL diagnostics remain under the recipient's project scope.

BSL LS release and exact source:

- https://github.com/1c-syntax/bsl-language-server/releases/tag/v1.0.7
- https://github.com/1c-syntax/bsl-language-server/tree/f377f95aefa16a4cf0e4d9af5b1c83800366bebc

BSL LS is LGPL-3.0. Its COPYING text, GPL-3.0 text and exact full upstream source
archive are shipped under runtime/bsl/notices. The executable JAR retains
embedded dependency licenses and notices.

Java release and matching source:

- https://github.com/adoptium/temurin21-binaries/releases/tag/jdk-21.0.13%2B9
- https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/OpenJDK21U-jdk-sources_21.0.13_9.tar.gz
- https://github.com/adoptium/temurin-build

The entire Java legal/ tree and NOTICE are retained under runtime/java. They
include GPL-2.0, the OpenJDK Assembly Exception, Classpath-related permissions
and third-party notices. Matching OpenJDK source is included as an archive
under runtime/bsl/notices; it is not executed by setup.

Binary provenance: official release assets, published SHA-256, plus a valid
Eclipse Foundation Authenticode signature on java.exe. The reviewed hashes,
versions and exact unpacked inventory are recorded in lock.mjs,
lock-files.mjs and the staged metadata.json. A payload hash is integrity data,
not an independent signing certificate for the whole distribution.
