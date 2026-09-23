package metrics

import (
	"expvar"
	"fmt"
	"log"
	"net/http"
	"sync/atomic"
)

var requests atomic.Int64

// Serve exposes Prometheus-style metrics and expvar on a separate port.
func Serve(addr string) {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		fmt.Fprintf(w, "# TYPE http_requests_total counter\nhttp_requests_total %d\n", requests.Load())
	})

	mux.HandleFunc("/debug/vars", func(w http.ResponseWriter, r *http.Request) {
		expvar.Handler().ServeHTTP(w, r)
	})

	log.Printf("metrics listening on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Printf("metrics server stopped: %v", err)
	}
}
