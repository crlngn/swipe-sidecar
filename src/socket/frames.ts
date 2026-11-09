/**
 * Minimal socket.io v4 text framing, enough to read and write the packets Swipe Sidecar cares about.
 *
 * engine.io wraps every socket.io packet in a message frame: "4" + packet. Other engine.io types
 * ("0" open, "2" ping, "3" pong, ...) are passed through untouched, as are binary packets ("45", "46").
 *
 * socket.io packet: <type>[<attachments>-][/<nsp>,][<ackId>][<json>]
 *   type 0 connect, 1 disconnect, 2 event, 3 ack, 4 connect_error, 5 binary event, 6 binary ack
 */
export interface Packet {
  /** socket.io packet type. */
  type: number;
  nsp: string;
  id: number | null;
  /** Parsed JSON body: for events `[name, ...args]`, for acks `[...args]`. */
  data: unknown;
}

export function parseFrame(text: string): Packet | null {
  if ( text[0] !== "4" ) return null;                      // not an engine.io message
  let i = 1;
  const type = Number(text[i++]);
  if ( !(type >= 0 && type <= 4) ) return null;             // binary packets are not touched
  let nsp = "/";
  if ( text[i] === "/" ) {
    const end = text.indexOf(",", i);
    if ( end === -1 ) return null;
    nsp = text.slice(i, end);
    i = end + 1;
  }
  let id: number | null = null;
  const start = i;
  while ( i < text.length && text[i] >= "0" && text[i] <= "9" ) i++;
  if ( i > start ) id = Number(text.slice(start, i));
  let data: unknown = undefined;
  if ( i < text.length ) {
    try { data = JSON.parse(text.slice(i)); } catch { return null; }
  }
  return { type, nsp, id, data };
}

export function buildFrame(packet: Packet): string {
  let out = `4${packet.type}`;
  if ( packet.nsp !== "/" ) out += `${packet.nsp},`;
  if ( packet.id !== null ) out += String(packet.id);
  if ( packet.data !== undefined ) out += JSON.stringify(packet.data);
  return out;
}

export const EVENT = 2;
export const ACK = 3;

export function eventFrame(name: string, ...args: unknown[]): string {
  return buildFrame({ type: EVENT, nsp: "/", id: null, data: [name, ...args] });
}
