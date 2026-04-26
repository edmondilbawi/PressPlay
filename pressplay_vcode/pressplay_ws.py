from typing import List
from fastapi import WebSocket


class ConnectionManager:
    def __init__(self):
        # room_name -> list of websocket connections
        self.rooms: dict[str, List[WebSocket]] = {}

    async def connect(self, websocket: WebSocket, room: str):
        await websocket.accept()
        if room not in self.rooms:
            self.rooms[room] = []
        self.rooms[room].append(websocket)

    def disconnect(self, websocket: WebSocket, room: str):
        if room in self.rooms and websocket in self.rooms[room]:
            self.rooms[room].remove(websocket)

    async def broadcast(self, room: str, message: str):
        if room not in self.rooms:
            return
        for ws in list(self.rooms[room]):
            try:
                await ws.send_text(message)
            except Exception:
                # If sending fails, ignore and continue
                pass


# global manager instance
manager = ConnectionManager()
