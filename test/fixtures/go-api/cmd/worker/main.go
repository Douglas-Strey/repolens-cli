package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/redis/go-redis/v9"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	rdb := redis.NewClient(&redis.Options{
		Addr: os.Getenv("REDIS_ADDR"),
	})
	defer rdb.Close()

	log.Println("worker started, waiting for jobs")

	for {
		res, err := rdb.BLPop(ctx, 0, "jobs").Result()
		if err != nil {
			if ctx.Err() != nil {
				log.Println("worker shutting down")
				return
			}
			log.Printf("blpop: %v", err)
			continue
		}
		log.Printf("processing job: %s", res[1])
	}
}
