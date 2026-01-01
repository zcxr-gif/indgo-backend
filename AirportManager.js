// AirportManager.js
import React, { useState, useEffect, useRef } from 'react';
import { 
  Camera, Upload, X, MapPin, User, Hash, Loader2, 
  CheckCircle2, ChevronDown, Trash2, Search, Image as ImageIcon
} from 'lucide-react';

const IS_LOCALHOST = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const AIRPORT_API = IS_LOCALHOST ? 'http://localhost:5000/api/airports' : '/api/airports';

export function AirportGallery() {
    const [icao, setIcao] = useState('');
    const [images, setImages] = useState([]);
    const [loading, setLoading] = useState(false);
    const [showUpload, setShowUpload] = useState(false);

    const fetchAirports = async (searchIcao) => {
        if (!searchIcao || searchIcao.length < 3) return;
        setLoading(true);
        try {
            const res = await fetch(`${AIRPORT_API}/${searchIcao.toUpperCase()}`);
            const data = await res.json();
            setImages(Array.isArray(data) ? data : []);
        } catch (err) {
            console.error("Fetch error:", err);
        } finally {
            setLoading(false);
        }
    };

    const handleSearch = (e) => {
        e.preventDefault();
        fetchAirports(icao);
    };

    const handleDelete = async (imageUrl) => {
        if (!confirm("Delete this airport image?")) return;
        try {
            await fetch(AIRPORT_API, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ imageUrl })
            });
            fetchAirports(icao);
        } catch (err) {
            alert("Delete failed");
        }
    };

    return (
        <div className="space-y-6 animate-in fade-in duration-500">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white dark:bg-slate-900 p-6 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm">
                <div>
                    <h2 className="text-2xl font-bold text-slate-900 dark:text-white">Airport Spotting</h2>
                    <p className="text-sm text-slate-500">Search by ICAO to see community terminal and apron shots</p>
                </div>
                <div className="flex items-center gap-2">
                    <form onSubmit={handleSearch} className="relative">
                        <input 
                            type="text" 
                            placeholder="Enter ICAO (e.g. KJFK)" 
                            className="pl-4 pr-10 py-2 bg-slate-100 dark:bg-slate-800 border-none rounded-xl text-sm font-bold uppercase tracking-widest focus:ring-2 focus:ring-blue-500 w-40"
                            value={icao}
                            onChange={(e) => setIcao(e.target.value.toUpperCase())}
                        />
                        <button type="submit" className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-blue-500">
                            <Search size={18} />
                        </button>
                    </form>
                    <button 
                        onClick={() => setShowUpload(true)}
                        className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-xl text-sm font-bold transition-all"
                    >
                        <Upload size={16} /> Upload
                    </button>
                </div>
            </div>

            {loading ? (
                <div className="flex flex-col items-center py-20"><Loader2 className="animate-spin text-blue-500" size={40} /></div>
            ) : images.length > 0 ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                    {images.map((img, idx) => (
                        <div key={idx} className="group bg-white dark:bg-slate-900 rounded-2xl overflow-hidden border border-slate-200 dark:border-slate-800 shadow-sm hover:shadow-md transition-all">
                            <div className="aspect-video bg-slate-100 dark:bg-slate-800 relative">
                                <img src={img.url} className="w-full h-full object-cover" alt={img.icao} />
                                <button 
                                    onClick={() => handleDelete(img.url)}
                                    className="absolute top-2 right-2 p-2 bg-red-500/80 text-white rounded-lg opacity-0 group-hover:opacity-100 transition-opacity"
                                >
                                    <Trash2 size={14} />
                                </button>
                            </div>
                            <div className="p-4 flex items-center justify-between">
                                <div>
                                    <p className="text-xs font-bold text-slate-400 uppercase">{img.contributorName}</p>
                                    <p className="text-sm font-bold text-slate-900 dark:text-white">{img.icao}</p>
                                </div>
                                <p className="text-[10px] text-slate-500">{new Date(img.uploadedAt).toLocaleDateString()}</p>
                            </div>
                        </div>
                    ))}
                </div>
            ) : icao.length >= 3 && (
                <div className="text-center py-20 bg-slate-50 dark:bg-slate-900/50 rounded-3xl border-2 border-dashed border-slate-200 dark:border-slate-800">
                    <ImageIcon size={48} className="mx-auto text-slate-300 mb-4" />
                    <p className="text-slate-500">No images found for {icao}. Be the first to upload one!</p>
                </div>
            )}

            {showUpload && <AirportUploadModal onClose={() => setShowUpload(false)} onRefresh={() => fetchAirports(icao)} />}
        </div>
    );
}

function AirportUploadModal({ onClose, onRefresh }) {
    const [loading, setLoading] = useState(false);
    const [preview, setPreview] = useState(null);
    const [formData, setFormData] = useState({ icao: '', contributorName: '' });
    const fileRef = useRef();

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!fileRef.current?.files[0]) return alert("Select an image");
        setLoading(true);
        const data = new FormData();
        data.append('icao', formData.icao);
        data.append('contributorName', formData.contributorName);
        data.append('image', fileRef.current.files[0]);

        try {
            const res = await fetch(AIRPORT_API, { method: 'POST', body: data });
            if (res.ok) {
                onRefresh();
                onClose();
            }
        } catch (err) {
            alert("Upload failed");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in">
            <div className="bg-white dark:bg-slate-900 rounded-3xl w-full max-w-md overflow-hidden shadow-2xl border border-slate-200 dark:border-slate-700">
                <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center">
                    <h3 className="font-bold text-xl">Upload Airport Image</h3>
                    <button onClick={onClose} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full"><X size={20}/></button>
                </div>
                <form onSubmit={handleSubmit} className="p-6 space-y-4">
                    <div 
                        onClick={() => fileRef.current.click()}
                        className="aspect-video rounded-2xl border-2 border-dashed border-slate-300 dark:border-slate-700 flex flex-col items-center justify-center cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors overflow-hidden"
                    >
                        {preview ? <img src={preview} className="w-full h-full object-cover" /> : (
                            <><Camera size={32} className="text-slate-400 mb-2" /><p className="text-xs font-bold text-slate-500">Click to upload photo</p></>
                        )}
                        <input type="file" hidden ref={fileRef} onChange={(e) => setPreview(URL.createObjectURL(e.target.files[0]))} />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <input 
                            required placeholder="ICAO" 
                            className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-800 rounded-xl border-none text-sm font-bold uppercase"
                            value={formData.icao}
                            onChange={(e) => setFormData({...formData, icao: e.target.value})}
                        />
                        <input 
                            required placeholder="Your Name" 
                            className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-800 rounded-xl border-none text-sm font-bold"
                            value={formData.contributorName}
                            onChange={(e) => setFormData({...formData, contributorName: e.target.value})}
                        />
                    </div>
                    <button 
                        disabled={loading}
                        className="w-full py-4 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-2xl shadow-lg shadow-blue-500/20 flex justify-center items-center gap-2"
                    >
                        {loading ? <Loader2 className="animate-spin" /> : <CheckCircle2 size={20} />}
                        {loading ? "Uploading..." : "Publish Image"}
                    </button>
                </form>
            </div>
        </div>
    );
}