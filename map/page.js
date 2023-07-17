"use strict";

/* global grist, window */

let amap;
let popups = {};
let selectedTableId = null;
let selectedRowId = null;
let selectedRecords = null;
let mode = 'multi';
// Required, Label value
const Name = "Name";
// Required
const Longitude = "Longitude";
// Required
const Latitude = "Latitude";
// Optional - switch column to trigger geocoding
const Geocode = 'Geocode';
// Optional - but required for geocoding. Field with address to find (might be formula)
const Address = 'Address';
// Optional - but 
const GeocodedAddress = 'GeocodedAddress';
let lastRecord;
let lastRecords;


const JVOPT_ANIMATE_CLUSTERS = true;
const JVOPT_SHOW_MODE = 2; 
const JVOPT_EXCLUDE_SELECTED_FROM_CLUSTERING = false 
//0 is original
//1 is to do nothing (works with removing selected row from flow)
//2 is to zoomToShowLayer (con: won't show all pins)
//3 is getVisibleParent(...).spiderfy()  (con: bad for zoom)
//4 is __parent.zoomToShowLayer (???)


// TODO JV TEMP:
//Color markers stolen from here:
//    https://blogs.absyz.com/2019/04/03/customizing-the-markers-in-your-leaflet-map/
//    https://github.com/pointhi/leaflet-color-markers
const selectedIcon =  new L.Icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-green.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41]
});
const defaultIcon =  new L.Icon.Default();



const geocoder = L.Control.Geocoder && L.Control.Geocoder.nominatim();
if (URLSearchParams && location.search && geocoder) {
  const c = new URLSearchParams(location.search).get('geocoder');
  if (c && L.Control.Geocoder[c]) {
    console.log('Using geocoder', c);
    geocoder = L.Control.Geocoder[c]();
  } else if (c) {
    console.warn('Unsupported geocoder', c);
  }
  const m = new URLSearchParams(location.search).get('mode');
  if (m) { mode = m; }
}

async function geocode(address) {
  return new Promise((resolve, reject) => {
    try {
      geocoder.geocode(address, (v) => {
        v = v[0];
        if (v) { v = v.center; }
        resolve(v);
      });
    } catch (e) {
      console.log("Problem:", e);
      reject(e);
    }
  });
}

async function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// If widget has wright access
let writeAccess = true;
// A ongoing scanning promise, to check if we are in progress.
let scanning = null;

async function scan(tableId, records, mappings) {
  if (!writeAccess) { return; }
  for (const record of records) {
    // We can only scan if Geocode column was mapped.
    if (!(Geocode in record)) { break; }
    // And the value in the column is truthy.
    if (!record[Geocode]) { continue; }
    // Get the address to search.
    const address = record.Address;
    // Little caching here. We will set GeocodedAddress to last address we searched,
    // so after next round - we will check if the address is indeed changed.
    // But this field is optional, if it is not in the record (not mapped)
    // we will find the location each time (if coordinates are empty).
    if (record[GeocodedAddress] && record[GeocodedAddress] !== record.Address) {
      // We have caching field, and last address is diffrent.
      // So clear coordinates (as if the record wasn't scanned before)
      record[Longitude] = null;
      record[Latitude] = null;
    }
    // If address is not empty, and coordinates are empty (or were cleared by cache)
    if (address && !record[Longitude]) {
      // Find coordinates.
      const result = await geocode(address);
      // Update them, and update cache (if the field was mapped)
      await grist.docApi.applyUserActions([ ['UpdateRecord', tableId, record.id, {
        [mappings[Longitude]]: result.lng,
        [mappings[Latitude]]: result.lat,
        ...(GeocodedAddress in mappings) ? {[mappings[GeocodedAddress]]: address} : undefined
      }] ]);
      await delay(1000);
    }
  }
}

function scanOnNeed(mappings) {
  if (!scanning && selectedTableId && selectedRecords) {
    scanning = scan(selectedTableId, selectedRecords, mappings).then(() => scanning = null).catch(() => scanning = null);
  }
}

function showProblem(txt) {
  document.getElementById('map').innerHTML = '<div class="error">' + txt + '</div>';
}

// Little extra wrinkle to deal with showing differences.  Should be taken
// care of by Grist once diffing is out of beta.
function parseValue(v) {
  if (typeof(v) === 'object' && v !== null && v.value && v.value.startsWith('V(')) {
    const payload = JSON.parse(v.value.slice(2, v.value.length - 1));
    return payload.remote || payload.local || payload.parent || payload;
  }
  return v;
}

function getInfo(rec) {
  const result = {
    id: rec.id,
    name: parseValue(rec[Name]),
    lng: parseValue(rec[Longitude]),
    lat: parseValue(rec[Latitude])
  };
  return result;
}

function updateMap(data) {
  data = data || selectedRecords;
  selectedRecords = data;
  if (!data || data.length === 0) {
    showProblem("No data found yet");
    return;
  }
  if (!(Longitude in data[0] && Latitude in data[0] && Name in data[0])) {
    showProblem("Table does not yet have all expected columns: Name, Longitude, Latitude. You can map custom columns"+
    " in the Creator Panel.");
    return;
  }


// FIXING map tiles. Source:
//    https://leaflet-extras.github.io/leaflet-providers/preview/
//    Old source was natgeo world map, but that only has data up to zoom 16
//    (can't zoom in tighter than about 10 city blocks across)
  const tiles_ESRI_world_street_map= L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
  //maxNativeZoom: 18, //I'm guessing on this one
  //maxZoom: 18.5, //lets stretch it a little
  attribution: 'Tiles &copy; Esri &mdash; Source: Esri, DeLorme, NAVTEQ, USGS, Intermap, iPC, NRCAN, Esri Japan, METI, Esri China (Hong Kong), Esri (Thailand), TomTom, 2012'
  });


  const tiles_ESRI_NatGeo_world_map = L.tileLayer('//server.arcgisonline.com/ArcGIS/rest/services/NatGeo_World_Map/MapServer/tile/{z}/{y}/{x}', {
    maxNativeZoom: 16,
    maxZoom: 17, //lets stretch our zoom a bit
    attribution: 'Tiles &copy; Esri &mdash; National Geographic, Esri, DeLorme, NAVTEQ, UNEP-WCMC, USGS, NASA, ESA, METI, NRCAN, GEBCO, NOAA, iPC'
  });

  const tiles_ESRI_WorldGrayCanvas = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    maxNativeZoom: 16,
    maxZoom: 17, //lets stretch our zoom a bit
    attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
    });

  const tiles = tiles_ESRI_world_street_map;
  //const tiles = tiles_ESRI_NatGeo_world_map;
  //const tiles = tiles_ESRI_WorldGrayCanvas;
  const error = document.querySelector('.error');
  if (error) { error.remove(); }
  if (amap) {
    try {
      amap.off();
      amap.remove();
    } catch (e) {
      // ignore
      console.warn(e);
    }
  }
  const map = L.map('map', {
    layers: [tiles],
    //zoomSnap: 1,
    //zoomDelta: 1,
    wheelPxPerZoomLevel: 90, //px, default 60, slows zooming
    //animate: false, //TEST: trying to make row selection less jumpy. Remove after snapping?
    //zoomAnimation: false,
    //markerZoomAnimation: false,

  });
  //Make sure clusters always show up above points
  //Default z-index for markers is 600, 650 is where tooltipPane z-index starts
  map.createPane('selectedMarker').style.zIndex = 620;
  map.createPane('clusters').style.zIndex = 610;

  const markers = L.markerClusterGroup({
    spiderfyOnMaxZoom: true, //TODO JV NEW
    disableClusteringAtZoom: 17, //if spiderfyOnMaxZoom=true, should spiderfy at 17
    maxClusterRadius: 30, //pixels, default 80
    showCoverageOnHover: true, //TODO JV TEMP: for debugging

    clusterPane: 'clusters', //lets uss style z-index for marker clusters

    animate: JVOPT_ANIMATE_CLUSTERS,
  });

  // //TODO JV TEMP: try to make animation return after initial setup
  // const restoreAnimate = () => {
  //   map.options.animate = true;
  //   map.options.zoomAnimation = true;
  //   map.options.markerZoomAnimation = true;
  //   markers.options.animate = true;
  // }

  const points = [];
  popups = {};
  for (const rec of data) {
    const {id, name, lng, lat} = getInfo(rec);
    if (String(lng) === '...') { continue; }
    if (Math.abs(lat) < 0.01 && Math.abs(lng) < 0.01) {
      // Stuff at 0,0 usually indicates bad imports/geocoding.
      continue;
    }
    const pt = new L.LatLng(lat, lng);
    const title = name;


    const icon = (id == selectedRowId) ? selectedIcon: defaultIcon;
    const markerOpts = { title, icon };
    if(selectedRowId == id)
      {markerOpts.pane = 'selectedMarker'; }

    const marker = L.marker(pt, markerOpts);
    points.push(pt);
    marker.bindPopup(title);

    //selected marker should be excluded from clustering, add directly to map
    if(id == selectedRowId && JVOPT_EXCLUDE_SELECTED_FROM_CLUSTERING) {
      map.addLayer(marker);
    } else {
      markers.addLayer(marker);
    }

    popups[id] = marker;
  }
  map.addLayer(markers);

  try {
    map.fitBounds(new L.LatLngBounds(points), {maxZoom: 15, padding: [0, 0]});
  } catch (err) {
    console.warn('cannot fit bounds');
  }
  function makeSureSelectedMarkerIsShown() {
    const rowId = selectedRowId;
    if (rowId && popups[rowId]) {


      window.m = markers

      var marker = popups[rowId];

      //JVOPT_SHOW_MODE (at top of file)
      //0 is original
      //1 is to do nothing (works with removing selected row from flow)
      //2 is to zoomToShowLayer (con: won't show all pins)
      //3 is getVisibleParent(...).spiderfy()  (con: bad for zoom)
      //4 is __parent.zoomToShowLayer (???)

      if(JVOPT_SHOW_MODE == 0) {
        if (!marker._icon) { marker.__parent.spiderfy(); }
      } else if (JVOPT_SHOW_MODE == 1) { //just show full zoomout
        //noop
        
      } else if (JVOPT_SHOW_MODE == 2) { //jump to marker
        markers.zoomToShowLayer(marker);

      } else if (JVOPT_SHOW_MODE == 3) { //spiderfy top level ancestor
        const visibleParent = markers.getVisibleParent(marker)
        if(visibleParent != null) 
          { visibleParent.spiderfy(); }

      } else if (JVOPT_SHOW_MODE == 4) { //zoom to immediate parent and spiderfy??
        if (!marker._icon) { markers.zoomToShowLayer(marker.__parent); }

      }
      marker.openPopup();
      

    }
  }
  map.on('zoomend', () => {
    // Should reshow marker if it has been lost, but I didn't find a good
    // event to trigger that exactly. A small timeout seems to work :-(
    // TODO: find a better way; also, if user has changed selection within
    // the map we should respect that.
    //setTimeout(makeSureSelectedMarkerIsShown, 500);
  });
  amap = map;

  makeSureSelectedMarkerIsShown();
}


grist.on('message', (e) => {
  if (e.tableId) { selectedTableId = e.tableId; }
});

function hasCol(col, anything) {
  return anything && typeof anything === 'object' && col in anything;
}

function defaultMapping(record, mappings) {
  if (!mappings) {
    return {
      [Longitude]: Longitude,
      [Name]: Name,
      [Latitude]: Latitude,
      [Address]: hasCol(Address, record) ? Address : null,
      [GeocodedAddress]: hasCol(GeocodedAddress, record) ? GeocodedAddress : null,
      [Geocode]: hasCol(Geocode, record) ? Geocode : null,
    };
  }
  return mappings;
}

function selectOnMap(rec) {
  selectedRowId = rec.id;
  if (mode === 'single') {
    updateMap([rec]);
  } else {
    updateMap();
  }
}

grist.onRecord((record, mappings) => {
  // If mappings are not done, we will assume that table has correct columns.
  // This is done to support existing widgets which where configured by
  // renaming column names.
  lastRecord = grist.mapColumnNames(record) || record;
  selectOnMap(lastRecord);
  if (mode === 'single') {
    scanOnNeed(defaultMapping(record, mappings));
  }
});
grist.onRecords((data, mappings) => {
  lastRecords = grist.mapColumnNames(data) || data;
  if (mode !== 'single') {
    // If mappings are not done, we will assume that table has correct columns.
    // This is done to support existing widgets which where configured by
    // renaming column names.
    updateMap(lastRecords);
    if (lastRecord) {
      selectOnMap(lastRecord);
    }
    // We need to mimic the mappings for old widgets
    scanOnNeed(defaultMapping(data[0], mappings));
  }
});

function updateMode() {
  if (mode === 'single') {
    selectedRowId = lastRecord.id;
    updateMap([lastRecord]);
  } else {
    updateMap(lastRecords);
  }
}

function onEditOptions() {
  const popup = document.getElementById("settings");
  popup.style.display = 'block';
  const btnClose = document.getElementById("btnClose");
  btnClose.onclick = () => popup.style.display = 'none';
  const checkbox = document.getElementById('cbxMode');
  checkbox.checked = mode === 'multi' ? true : false;
  checkbox.onchange = async (e) => {
    const newMode = e.target.checked ? 'multi' : 'single';
    if (newMode != mode) {
      mode = newMode;
      await grist.setOption('mode', mode);
      updateMode();
    }
  }
}

const optional = true;
grist.ready({
  columns: [
    "Name",
    { name: "Longitude", type: 'Numeric'} ,
    { name: "Latitude", type: 'Numeric'},
    { name: "Geocode", type: 'Bool', title: 'Geocode', optional},
    { name: "Address", type: 'Text', optional, optional},
    { name: "GeocodedAddress", type: 'Text', title: 'Geocoded Address', optional},
  ],
  onEditOptions
});

grist.onOptions((options, interaction) => {
  writeAccess = interaction.accessLevel === 'full';
  const newMode = options?.mode ?? mode;
  mode = newMode;
  if (newMode != mode && lastRecords) {
    updateMode();
  }
});
