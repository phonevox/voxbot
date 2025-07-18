FROM python:3.12-slim

WORKDIR /app

COPY system-packages.txt ./

RUN apt-get update && \
    xargs -a system-packages.txt apt-get install -y && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .env ./

RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["python", "main.py"]