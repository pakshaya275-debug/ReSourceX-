/* ReSourceX: map view for recipient matches and "use my location" buttons.
   Positions shown to other users are rounded to about 1 km by the server, so markers are approximate by design.
   Leaflet and OpenStreetMap tiles are loaded from public CDNs; if they fail, the list still works. */
(function () {
    "use strict";
    var map = null, markers = null, youMarker = null;

    function esc(value) {
        return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    }
    function setStatus(el, text) { if (el) el.textContent = text; }

    // "Use my location": fills the latitude/longitude inputs named in data-use-location="lat,lon,statusId".
    document.addEventListener("click", function (event) {
        var button = event.target.closest && event.target.closest("[data-use-location]");
        if (!button) return;
        var parts = button.getAttribute("data-use-location").split(",");
        var latInput = document.getElementById(parts[0]), lonInput = document.getElementById(parts[1]);
        var status = document.getElementById(parts[2]);
        if (!latInput || !lonInput) return;
        if (!navigator.geolocation) { setStatus(status, "This browser cannot read your location. Type the coordinates instead."); return; }
        setStatus(status, "Finding your location…");
        navigator.geolocation.getCurrentPosition(function (position) {
            latInput.value = position.coords.latitude.toFixed(5);
            lonInput.value = position.coords.longitude.toFixed(5);
            setStatus(status, "Location set. Only a rounded position (about 1 km) is shared with other users.");
            document.dispatchEvent(new CustomEvent("rx:location"));
        }, function (error) {
            setStatus(status, error.code === 1
                ? "Location permission was denied. You can type the coordinates instead."
                : "Could not get your location. Try again, or type the coordinates instead.");
        }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
    });

    function seekerCoords() {
        var lat = document.getElementById("recipientLatitude"), lon = document.getElementById("recipientLongitude");
        if (!lat || !lon || lat.value === "" || lon.value === "") return null;
        var latitude = Number(lat.value), longitude = Number(lon.value);
        return isFinite(latitude) && isFinite(longitude) ? { latitude: latitude, longitude: longitude } : null;
    }

    function render(matches) {
        var box = document.getElementById("resourceMap"), note = document.getElementById("mapNote");
        if (!box) return;
        if (!matches || !matches.length) { box.hidden = true; setStatus(note, ""); return; }
        box.hidden = false;
        var placedCount = matches.filter(function (m) { return m.coordinates && isFinite(m.coordinates.latitude) && isFinite(m.coordinates.longitude); }).length;
        var missingCount = matches.length - placedCount;
        var summary = placedCount + " of " + matches.length + " matches are on the map (about 1 km accuracy)." +
            (missingCount ? " " + missingCount + " have no map position yet." : "");
        if (typeof window.L === "undefined") {
            setStatus(note, summary + " The map could not load (check your connection); the list below still shows every match.");
            return;
        }
        if (!map) {
            map = L.map(box).setView([20.5937, 78.9629], 5);
            L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
                maxZoom: 18, attribution: "&copy; OpenStreetMap contributors"
            }).addTo(map);
            markers = L.layerGroup().addTo(map);
        }
        markers.clearLayers();
        if (youMarker) { youMarker.remove(); youMarker = null; }

        var points = [];
        var placed = matches.filter(function (m) { return m.coordinates && isFinite(m.coordinates.latitude) && isFinite(m.coordinates.longitude); });
        placed.forEach(function (m, index) {
            var point = [m.coordinates.latitude, m.coordinates.longitude];
            points.push(point);
            var popup = document.createElement("div");
            popup.className = "map-popup";
            popup.innerHTML = "<strong>#" + (index + 1) + " " + esc(m.name) + "</strong><br>" +
                esc(m.category || "Other") + " · " + esc(String(m.quantity)) + " available<br>" +
                esc(String(m.matchScore)) + "% match<br>" +
                '<button type="button" class="view-details-btn" onclick="viewResource(\'' + esc(m.id) + '\')">View details</button>';
            L.circleMarker(point, { radius: 9, color: "#087f5b", weight: 2, fillColor: "#0f9d82", fillOpacity: 0.85 })
                .bindPopup(popup)
                .addTo(markers);
        });

        var seeker = seekerCoords();
        if (seeker) {
            youMarker = L.circleMarker([seeker.latitude, seeker.longitude], { radius: 6, color: "#1c7ed6", weight: 2, fillColor: "#74c0fc", fillOpacity: 1 })
                .bindTooltip("You are here").addTo(map);
            points.push([seeker.latitude, seeker.longitude]);
        }
        if (points.length) map.fitBounds(points, { padding: [30, 30], maxZoom: 12 });
        setTimeout(function () { map.invalidateSize(); }, 0);

        setStatus(note, summary);
    }

    window.ResourceXMap = { render: render, seekerCoords: seekerCoords };
})();
