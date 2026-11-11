"""Offline mode only: fixed TCP relay from loopback publish to internal Cognee.

No HTTP parsing, logging, credentials, dynamic target, model import or disk I/O.
The Cognee server itself belongs only to the internal network and has no egress.
"""
import asyncio

slots = asyncio.Semaphore(64)

async def relay(reader, writer):
    try:
        async with slots:
            remote_reader, remote_writer = await asyncio.wait_for(
                asyncio.open_connection('cognee', 8000), timeout=5
            )
            async def copy(source, destination):
                try:
                    while True:
                        data = await asyncio.wait_for(source.read(65536), timeout=120)
                        if not data:
                            break
                        destination.write(data)
                        await destination.drain()
                finally:
                    destination.close()
            await asyncio.gather(copy(reader, remote_writer), copy(remote_reader, writer))
    except Exception:
        writer.close()

async def main():
    server = await asyncio.start_server(relay, '0.0.0.0', 8000, limit=131072)
    async with server:
        await server.serve_forever()

asyncio.run(main())
