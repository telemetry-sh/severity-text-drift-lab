.PHONY: check run docker

check:
	npm run check

run:
	npm start

docker:
	docker compose up --build
