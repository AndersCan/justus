/* The p2p stack ships no type declarations; ambient `any` surfaces are fine —
 * the store code guards its usage defensively. */

declare module "corestore" {
  const Corestore: any;
  export default Corestore;
}

declare module "hyperdrive" {
  const Hyperdrive: any;
  export default Hyperdrive;
}

declare module "hyperswarm" {
  const Hyperswarm: any;
  export default Hyperswarm;
}
