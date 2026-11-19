/** Addresses this phone's peer network used: `host:port` and when each was last used (ms epoch, this phone's clock). Dev builds only; read at `/__state` as `addresses`. */
export type AddressLog = {
  /** This phone's own UDP sockets. */
  bound: Record<string, number>;
  /** Every UDP packet's destination: lookup nodes, and phones while connecting. */
  sent: Record<string, number>;
  /** The far end of every peer connection: where photos travel. */
  streams: Record<string, number>;
};

export type UdxLike = {
  createSocket(opts?: unknown): any;
  createStream(id: number, opts?: unknown): any;
};

export function emptyAddressLog(): AddressLog {
  return { bound: {}, sent: {}, streams: {} };
}

/** Makes every socket and stream `udx` creates from now on note its addresses in `log` before it acts. Returns `udx`. */
export function watchAddresses<U extends UdxLike>(udx: U, log: AddressLog): U {
  const createSocket = udx.createSocket.bind(udx);
  const createStream = udx.createStream.bind(udx);
  udx.createSocket = (opts?: unknown) => {
    const socket = createSocket(opts);
    const bind = socket.bind.bind(socket);
    const send = socket.send.bind(socket);
    const trySend = socket.trySend.bind(socket);
    socket.bind = (port: number, host: string, ...rest: unknown[]) => {
      const result = bind(port, host, ...rest);
      const a = socket.address();
      log.bound[`${a.host}:${a.port}`] = Date.now();
      return result;
    };
    socket.send = (buffer: unknown, port: number, host: string, ...rest: unknown[]) => {
      log.sent[`${host}:${port}`] = Date.now();
      return send(buffer, port, host, ...rest);
    };
    socket.trySend = (buffer: unknown, port: number, host: string, ...rest: unknown[]) => {
      log.sent[`${host}:${port}`] = Date.now();
      return trySend(buffer, port, host, ...rest);
    };
    return socket;
  };
  udx.createStream = (id: number, opts?: unknown) => {
    const stream = createStream(id, opts);
    const connect = stream.connect.bind(stream);
    const changeRemote = stream.changeRemote.bind(stream);
    stream.connect = (
      socket: unknown,
      remoteId: number,
      port: number,
      host: string,
      ...rest: unknown[]
    ) => {
      log.streams[`${host}:${port}`] = Date.now();
      return connect(socket, remoteId, port, host, ...rest);
    };
    stream.changeRemote = (
      socket: unknown,
      remoteId: number,
      port: number,
      host: string,
      ...rest: unknown[]
    ) => {
      log.streams[`${host}:${port}`] = Date.now();
      return changeRemote(socket, remoteId, port, host, ...rest);
    };
    return stream;
  };
  return udx;
}
