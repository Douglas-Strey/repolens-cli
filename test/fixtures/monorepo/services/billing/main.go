package main

import (
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/google/uuid"
)

type Invoice struct {
	ID        string    `json:"id"`
	AmountDue int64     `json:"amountDue"`
	IssuedAt  time.Time `json:"issuedAt"`
}

func main() {
	http.HandleFunc("/invoices", func(w http.ResponseWriter, r *http.Request) {
		invoices := []Invoice{
			{ID: uuid.NewString(), AmountDue: 4200, IssuedAt: time.Now().UTC()},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(invoices)
	})

	log.Println("billing service listening on :8081")
	log.Fatal(http.ListenAndServe(":8081", nil))
}
