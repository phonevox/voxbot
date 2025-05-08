FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .env ./

RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["python", "__main__.py"]