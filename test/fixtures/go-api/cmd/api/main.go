package main

import (
	"context"
	"log"
	"net/http"
	"os"

	"github.com/gin-gonic/gin"

	"github.com/acme/go-api/internal/db"
	"github.com/acme/go-api/internal/handlers"
	"github.com/acme/go-api/internal/metrics"
)

func main() {
	ctx := context.Background()

	pool, err := db.Connect(ctx)
	if err != nil {
		log.Fatalf("connect database: %v", err)
	}
	defer pool.Close()

	users := handlers.NewUserHandler(pool)

	r := gin.Default()

	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})

	v1 := r.Group("/api/v1")
	{
		v1.GET("/users", users.List)
		v1.POST("/users", users.Create)
		v1.GET("/users/:id", users.Get)
	}

	go metrics.Serve(":9090")

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	if err := r.Run(":" + port); err != nil {
		log.Fatal(err)
	}
}
