/* The p2p stack ships no type declarations; ambient `any` surfaces are fine —
 * the store code guards its usage defensively. */

declare module "corestore" {
  const Corestore: any;
  export default Corestore;
}

declare module "hypercore" {
  const Hypercore: any;
  export default Hypercore;
}

declare module "hypercore-crypto" {
  const crypto: any;
  export default crypto;
}

declare module "hyperdrive" {
  const Hyperdrive: any;
  export default Hyperdrive;
}

declare module "hyperswarm" {
  const Hyperswarm: any;
  export default Hyperswarm;
}

declare module "protomux" {
  const Protomux: any;
  export default Protomux;
}

declare module "compact-encoding" {
  const c: any;
  export default c;
}
declare module "hyperdht/testnet" {
  const createTestnet: any;
  export default createTestnet;
}
