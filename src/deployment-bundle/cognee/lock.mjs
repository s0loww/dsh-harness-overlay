export const COGNEE_LOCK = Object.freeze({
  version: '1.6.7',
  sourceRevision: '8853378eae5366addb064e758e560a456146ae1a',
  image: 'cognee/cognee@sha256:84584eade25cd9526ef4fe8dd550be69fb974fb1083bde9e498da451fad0dfc6',
  imageId: 'sha256:84584eade25cd9526ef4fe8dd550be69fb974fb1083bde9e498da451fad0dfc6',
  localImage: 'airules-cognee:1.6.7-84584eade25c',
  platform: 'linux/amd64',
  models: [
    { name: 'fastino/gliner2.5-base-v1', folder: 'huggingface/hub/models--fastino--gliner2.5-base-v1', revision: '07d99c0ba5d15cb3b24e0a236fa99bdd4ef87a5c' },
    { name: 'BAAI/bge-small-en-v1.5', folder: 'huggingface/hub/models--BAAI--bge-small-en-v1.5', revision: '5c38ec7c405ec4b44b94cc5a9bb96e735b38267a' },
    { name: 'Qdrant/bge-small-en-v1.5-onnx-Q', folder: 'fastembed/models--Qdrant--bge-small-en-v1.5-onnx-Q', revision: 'aa8f8b060edb00e03bfdd08813a2949946c8ba55' },
  ],
})

// Same sealed image: containerd store reports the manifest digest; classic
// Docker reports the config digest recorded in image.tar/manifest.json.Config.
export const COGNEE_IMAGE_IDS = Object.freeze([
  COGNEE_LOCK.imageId,
  'sha256:03a4c4e763255887295280b2ddaef862c92931f7088f4f792a017c92665ccd36',
])
