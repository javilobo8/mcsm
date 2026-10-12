package conn

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// ErrTransferNotFound: el panel respondió 404 al transfer_id (caducado, ya usado o de otro nodo).
var ErrTransferNotFound = errors.New("el panel no reconoce la transferencia (caducada, ya usada o de otro nodo)")

// errTransferAuth: el panel rechazó el token del nodo (401/403). No se reintenta: el mismo
// token volvería a fallar.
var errTransferAuth = errors.New("el panel rechazó el token del nodo")

// transferIDRe: 32 bytes aleatorios en base64url sin relleno, como los genera el panel.
var transferIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

const (
	// transferHeaderTimeout acota la espera de la respuesta una vez enviada la petición entera
	// (en un PUT, tras el último byte del cuerpo). Los cuerpos no tienen plazo: un envío grande
	// puede tardar lo que haga falta y solo lo corta el context.
	transferHeaderTimeout = 60 * time.Second
	panelErrBodyMax       = 4 << 10 // bytes leídos del cuerpo de una respuesta de error
	panelErrMsgMax        = 300     // bytes del mensaje del panel que pasan al error
)

// newTransferHTTP crea el cliente de transferencias. Plazos solo para conectar y para esperar
// cabeceras; nunca para el cuerpo completo.
func newTransferHTTP(headerTimeout time.Duration) *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			DialContext:           (&net.Dialer{Timeout: dialTimeout, KeepAlive: 30 * time.Second}).DialContext,
			TLSHandshakeTimeout:   dialTimeout,
			ResponseHeaderTimeout: headerTimeout,
			// Una conexión por transferencia (son pocas y largas): sin conexiones reutilizadas
			// net/http no reintenta por su cuenta una petición que el panel pudo recibir (un GET
			// repetido encontraría la transferencia ya consumida) y no quedan goroutines ociosas.
			DisableKeepAlives: true,
			// Bytes tal cual: Content-Length es el tamaño real y no hay descompresión sin tope.
			DisableCompression: true,
		},
		// Sin redirecciones: un 302 convertiría el PUT en un GET sin cuerpo que "funcionaría" y
		// llevaría la petición, con el token, a otra ruta.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

var transferHTTP = newTransferHTTP(transferHeaderTimeout)

// TransferClient hace las transferencias HTTP salientes del agente (spec §5.1): GET y PUT
// /agent/transfer/{id} contra el panel con el token del nodo. No escribe logs y sus errores
// nunca llevan el token.
type TransferClient struct {
	base  string
	token string
	http  *http.Client
}

// NewTransferClient crea un cliente para el panel en panelURL con el token del nodo.
func NewTransferClient(panelURL, token string) *TransferClient {
	return &TransferClient{base: strings.TrimRight(panelURL, "/"), token: token, http: transferHTTP}
}

// do envía la petición y devuelve la respuesta solo si es 2xx (el llamante cierra su cuerpo).
func (c *TransferClient) do(ctx context.Context, method, id string, body io.Reader, size int64) (*http.Response, error) {
	if !transferIDRe.MatchString(id) {
		return nil, errors.New("transfer_id inválido")
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+"/agent/transfer/"+id, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	if body != nil {
		req.ContentLength = size
		req.Header.Set("Content-Type", "application/octet-stream")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	if err := c.statusErr(resp); err != nil {
		resp.Body.Close()
		return nil, err
	}
	return resp, nil
}

func (c *TransferClient) statusErr(resp *http.Response) error {
	switch code := resp.StatusCode; {
	case code >= 200 && code < 300:
		return nil
	case code == http.StatusNotFound:
		return ErrTransferNotFound
	case code == http.StatusUnauthorized || code == http.StatusForbidden:
		return fmt.Errorf("%w (%d)", errTransferAuth, code)
	default:
		return fmt.Errorf("el panel respondió %d: %s", code, c.panelMessage(resp))
	}
}

// panelMessage extrae el mensaje de una respuesta de error del panel ({"error": "…"}), sin el
// token y en UTF-8 válido. Otro cuerpo (la página de un proxy, por ejemplo) no se copia: queda
// el texto del estado HTTP.
func (c *TransferClient) panelMessage(resp *http.Response) string {
	msg := http.StatusText(resp.StatusCode)
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, panelErrBodyMax))
	var body struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(raw, &body) == nil && strings.TrimSpace(body.Error) != "" {
		msg = strings.TrimSpace(body.Error)
	}
	if c.token != "" {
		msg = strings.ReplaceAll(msg, c.token, "[token]")
	}
	if len(msg) > panelErrMsgMax {
		msg = msg[:panelErrMsgMax] + "…"
	}
	if msg == "" {
		msg = "sin detalle"
	}
	return strings.ToValidUTF8(msg, "�")
}

// Get abre una transferencia panel → agente. Devuelve el cuerpo en streaming (el llamante lo
// cierra) y su tamaño, o -1 si el panel no envió Content-Length. Con Content-Length el cuerpo
// entrega exactamente esos bytes: si el panel corta antes, la lectura falla con
// io.ErrUnexpectedEOF. Cancelar ctx corta también la lectura del cuerpo.
func (c *TransferClient) Get(ctx context.Context, id string) (io.ReadCloser, int64, error) {
	resp, err := c.do(ctx, http.MethodGet, id, nil, 0)
	if err != nil {
		return nil, 0, err
	}
	return resp.Body, resp.ContentLength, nil
}

// readerOnly oculta Close (y cualquier otro método) del cuerpo del llamante.
type readerOnly struct{ io.Reader }

// Put envía body en una transferencia agente → panel y vuelve cuando el panel responde 2xx
// (lo ha recibido y entregado entero). size >= 0 fija Content-Length (0 envía un cuerpo vacío)
// y la petición falla si body no trae exactamente size bytes; -1 usa chunked. Put no cierra
// body; como en net/http, tras un error body aún puede estar leyéndose un instante en otra
// goroutine: el llamante no debe reutilizarlo, solo cerrarlo (*os.File e io.Pipe lo admiten).
func (c *TransferClient) Put(ctx context.Context, id string, body io.Reader, size int64) error {
	if body == nil {
		body = http.NoBody
	}
	switch {
	case size == 0:
		body = http.NoBody // con ContentLength 0 y un cuerpo no nulo, net/http usaría chunked
	case size > 0 && size+1 > 0:
		// Si body trae de más, net/http leería el resto entero para medirlo (con un origen que
		// no acaba, para siempre); un byte de más basta para fallar.
		body = io.LimitReader(body, size+1)
	default:
		if size < 0 {
			size = -1
		}
		body = readerOnly{body}
	}
	resp, err := c.do(ctx, http.MethodPut, id, body, size)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}
